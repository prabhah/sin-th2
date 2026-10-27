package main

import (
	"bytes"
	"encoding/binary"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"go.bug.st/serial"
)

const (
	baudRate = 57600
)

type Device struct {
	portName string
	mu       sync.Mutex
}

type Record struct {
	Index       int     `json:"index"`
	Time        string  `json:"time,omitempty"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
}

type Meta struct {
	Capacity    uint32 `json:"capacity"`
	RecordCount uint32 `json:"recordCount"`
	LastUnix    uint32 `json:"lastUnix"`
	IntervalSec int    `json:"intervalSec"`
	DeviceTime  string `json:"deviceTime"`
	Model       string `json:"model"`
	Recording   bool   `json:"recording"`
}

func crc16(data []byte) uint16 {
	crc := uint16(0xFFFF)
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}

func frame(data []byte) []byte {
	out := append([]byte{}, data...)
	c := crc16(data)
	return append(out, byte(c), byte(c>>8))
}

func checkCRC(b []byte) error {
	if len(b) < 4 {
		return errors.New("response too short")
	}
	got := binary.LittleEndian.Uint16(b[len(b)-2:])
	want := crc16(b[:len(b)-2])
	if got != want {
		return fmt.Errorf("CRC mismatch: got=%04x want=%04x", got, want)
	}
	return nil
}

func (d *Device) open() (serial.Port, error) {
	return serial.Open(d.portName, &serial.Mode{
		BaudRate: baudRate,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	})
}

func readExact(p serial.Port, n int) ([]byte, error) {
	if err := p.SetReadTimeout(1200 * time.Millisecond); err != nil {
		return nil, err
	}
	buf := make([]byte, n)
	off := 0
	for off < n {
		nn, err := p.Read(buf[off:])
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if nn == 0 {
			return nil, fmt.Errorf("timeout: expected %d bytes, got %d", n, off)
		}
		off += nn
	}
	return buf, nil
}

func transact(p serial.Port, req []byte, responseLen int) ([]byte, error) {
	if err := p.ResetInputBuffer(); err != nil {
		return nil, err
	}
	if err := p.ResetOutputBuffer(); err != nil {
		return nil, err
	}
	if _, err := p.Write(req); err != nil {
		return nil, err
	}
	rx, err := readExact(p, responseLen)
	if err != nil {
		return nil, err
	}
	if err := checkCRC(rx); err != nil {
		return nil, err
	}
	return rx, nil
}

func (d *Device) withPort(fn func(serial.Port) error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, err := d.open()
	if err != nil {
		return err
	}
	defer p.Close()
	return fn(p)
}

func (d *Device) modelWithPort(p serial.Port) (string, error) {
	rx, err := transact(p, frame([]byte{0x01, 0x10, 0x00}), 14)
	if err != nil {
		return "", err
	}
	if rx[0] != 1 || rx[1] != 0x10 {
		return "", errors.New("unexpected 0x10 response")
	}
	n := int(binary.BigEndian.Uint16(rx[2:4]))
	if 4+n+2 != len(rx) {
		return "", errors.New("bad model response length")
	}
	return string(bytes.TrimRight(rx[4:4+n], "\x00")), nil
}

func (d *Device) configWithPort(p serial.Port) ([]byte, error) {
	// Today's reverse engineering established a 118-byte 0x12 response:
	// 01 12 + 114-byte payload + CRC16.
	rx, err := transact(p, frame([]byte{0x01, 0x12, 0x00}), 118)
	if err != nil {
		return nil, err
	}
	if rx[0] != 1 || rx[1] != 0x12 {
		return nil, errors.New("unexpected 0x12 response")
	}
	return append([]byte{}, rx[2:len(rx)-2]...), nil
}

func decodeRTC(cfg []byte) (time.Time, error) {
	if len(cfg) < 6 {
		return time.Time{}, errors.New("config too short")
	}
	return time.Date(2000+int(cfg[0]), time.Month(cfg[1]), int(cfg[2]),
		int(cfg[3]), int(cfg[4]), int(cfg[5]), 0, time.Local), nil
}

func intervalSeconds(cfg []byte) int {
	if len(cfg) < 75 {
		return 0
	}
	return int(cfg[72])*3600 + int(cfg[73])*60 + int(cfg[74])
}

func (d *Device) metaWithPort(p serial.Port) ([]uint32, error) {
	rx, err := transact(p, frame([]byte{0x01, 0x17, 0x00}), 36)
	if err != nil {
		return nil, err
	}
	if rx[0] != 1 || rx[1] != 0x17 {
		return nil, errors.New("unexpected 0x17 response")
	}
	payload := rx[2 : len(rx)-2]
	words := make([]uint32, 0, len(payload)/4)
	for i := 0; i+4 <= len(payload); i += 4 {
		words = append(words, binary.BigEndian.Uint32(payload[i:i+4]))
	}
	return words, nil
}

func (d *Device) Meta() (Meta, error) {
	var out Meta
	err := d.withPort(func(p serial.Port) error {
		model, err := d.modelWithPort(p)
		if err != nil {
			return err
		}
		cfg, err := d.configWithPort(p)
		if err != nil {
			return err
		}
		rtc, err := decodeRTC(cfg)
		if err != nil {
			return err
		}
		words, err := d.metaWithPort(p)
		if err != nil {
			return err
		}
		if len(words) < 4 {
			return errors.New("short metadata")
		}
		out.Model = model
		out.DeviceTime = rtc.Format("2006-01-02 15:04:05")
		out.IntervalSec = intervalSeconds(cfg)
		out.LastUnix = words[1]
		out.Capacity = words[2]
		out.RecordCount = words[3]
		// Status is not fully decoded yet. A non-zero record count alone does not mean active.
		return nil
	})
	return out, err
}

func readRecordsWithPort(p serial.Port, start, count, total, interval int, last time.Time) ([]Record, error) {
	reqData := []byte{0x01, 0x13}
	idx := make([]byte, 4)
	binary.BigEndian.PutUint32(idx, uint32(start))
	reqData = append(reqData, idx...)
	reqData = append(reqData, byte(count))

	expected := 3 + count*8 + 2
	rx, err := transact(p, frame(reqData), expected)
	if err != nil {
		return nil, err
	}
	if rx[0] != 1 || rx[1] != 0x13 || int(rx[2]) != count {
		return nil, errors.New("unexpected 0x13 response")
	}

	first := last.Add(-time.Duration(total-1) * time.Duration(interval) * time.Second)
	data := rx[3 : len(rx)-2]
	records := make([]Record, 0, count)
	for i := 0; i < count; i++ {
		r := data[i*8 : (i+1)*8]
		temp := int16(binary.BigEndian.Uint16(r[4:6]))
		hum := binary.BigEndian.Uint16(r[6:8])
		t := first.Add(time.Duration(start+i) * time.Duration(interval) * time.Second)
		records = append(records, Record{
			Index:       start + i + 1,
			Time:        t.Format("2006-01-02 15:04:05"),
			Temperature: float64(temp) / 10,
			Humidity:    float64(hum) / 10,
		})
	}
	return records, nil
}

func (d *Device) ReadRecords(start, count int) ([]Record, error) {
	if start < 0 || count < 1 || count > 60 {
		return nil, errors.New("count must be 1..60 and start >= 0")
	}
	var records []Record
	err := d.withPort(func(p serial.Port) error {
		cfg, err := d.configWithPort(p)
		if err != nil {
			return err
		}
		interval := intervalSeconds(cfg)
		words, err := d.metaWithPort(p)
		if err != nil {
			return err
		}
		if len(words) < 4 {
			return errors.New("short metadata")
		}
		total := int(words[3])
		if start >= total {
			records = []Record{}
			return nil
		}
		if start+count > total {
			count = total - start
		}

		// 0x17 word[1] was empirically observed to track the last sample timestamp.
		// Use it to reconstruct timestamps from the fixed sampling interval.
		last := time.Unix(int64(words[1]), 0).UTC()
		records, err = readRecordsWithPort(p, start, count, total, interval, last)
		return err
	})
	return records, err
}

func (d *Device) ReadAllRecords() ([]Record, error) {
	var records []Record
	err := d.withPort(func(p serial.Port) error {
		cfg, err := d.configWithPort(p)
		if err != nil {
			return err
		}
		interval := intervalSeconds(cfg)
		words, err := d.metaWithPort(p)
		if err != nil {
			return err
		}
		if len(words) < 4 {
			return errors.New("short metadata")
		}
		total := int(words[3])
		records = make([]Record, 0, total)
		last := time.Unix(int64(words[1]), 0).UTC()
		for start := 0; start < total; start += 60 {
			count := min(60, total-start)
			batch, err := readRecordsWithPort(p, start, count, total, interval, last)
			if err != nil {
				return err
			}
			records = append(records, batch...)
		}
		return nil
	})
	return records, err
}

func (d *Device) Current() (Record, error) {
	var out Record
	err := d.withPort(func(p serial.Port) error {
		rx, err := transact(p, frame([]byte{0x01, 0x15, 0x00}), 8)
		if err != nil {
			return err
		}
		temp := int16(binary.BigEndian.Uint16(rx[2:4]))
		hum := binary.BigEndian.Uint16(rx[4:6])
		out = Record{
			Time:        time.Now().Format("2006-01-02 15:04:05"),
			Temperature: float64(temp) / 10,
			Humidity:    float64(hum) / 10,
		}
		return nil
	})
	return out, err
}

func (d *Device) SyncTimeFiveMinutes() (time.Time, error) {
	var verified time.Time
	err := d.withPort(func(p serial.Port) error {
		cfg, err := d.configWithPort(p)
		if err != nil {
			return err
		}
		if len(cfg) < 98 {
			return fmt.Errorf("config payload too short: %d", len(cfg))
		}

		// 0x11 writes the first 98 bytes of the 0x12 configuration.
		// Confirmed side effect: it clears historical records.
		writable := append([]byte{}, cfg[:98]...)
		now := time.Now()
		if now.Year() < 2000 || now.Year() > 2255 {
			return errors.New("local year outside device range")
		}
		writable[0] = byte(now.Year() - 2000)
		writable[1] = byte(now.Month())
		writable[2] = byte(now.Day())
		writable[3] = byte(now.Hour())
		writable[4] = byte(now.Minute())
		writable[5] = byte(now.Second())

		writable[72], writable[73], writable[74] = 0, 5, 0

		req := frame(append([]byte{0x01, 0x11}, writable...))
		rx, err := transact(p, req, 5)
		if err != nil {
			return err
		}
		if rx[0] != 1 || rx[1] != 0x11 || rx[2] != 1 {
			return fmt.Errorf("device rejected config: %x", rx)
		}

		time.Sleep(1200 * time.Millisecond)
		after, err := d.configWithPort(p)
		if err != nil {
			return err
		}
		verified, err = decodeRTC(after)
		if err != nil {
			return err
		}
		if intervalSeconds(after) != 300 {
			return errors.New("device did not retain 5-minute interval")
		}
		return nil
	})
	return verified, err
}

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func jsonErr(w http.ResponseWriter, err error, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
}

func main() {
	port := flag.String("port", "/dev/cu.usbserial-10", "serial port")
	addr := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	flag.Parse()

	dev := &Device{portName: *port}

	http.Handle("/", http.FileServer(http.Dir("./web")))

	http.HandleFunc("/api/meta", func(w http.ResponseWriter, r *http.Request) {
		m, err := dev.Meta()
		if err != nil {
			jsonErr(w, err, 500)
			return
		}
		jsonOut(w, m)
	})

	http.HandleFunc("/api/current", func(w http.ResponseWriter, r *http.Request) {
		x, err := dev.Current()
		if err != nil {
			jsonErr(w, err, 500)
			return
		}
		jsonOut(w, x)
	})

	http.HandleFunc("/api/records", func(w http.ResponseWriter, r *http.Request) {
		start, _ := strconv.Atoi(r.URL.Query().Get("start"))
		count, _ := strconv.Atoi(r.URL.Query().Get("count"))
		if count == 0 {
			count = 60
		}
		x, err := dev.ReadRecords(start, count)
		if err != nil {
			jsonErr(w, err, 400)
			return
		}
		jsonOut(w, x)
	})

	http.HandleFunc("/api/records.csv", func(w http.ResponseWriter, r *http.Request) {
		x, err := dev.ReadAllRecords()
		if err != nil {
			jsonErr(w, err, 500)
			return
		}
		var out bytes.Buffer
		out.WriteString("\xEF\xBB\xBF")
		csvWriter := csv.NewWriter(&out)
		_ = csvWriter.Write([]string{"序号", "时间", "温度 °C", "湿度 %RH"})
		for _, record := range x {
			_ = csvWriter.Write([]string{
				strconv.Itoa(record.Index),
				record.Time,
				strconv.FormatFloat(record.Temperature, 'f', 1, 64),
				strconv.FormatFloat(record.Humidity, 'f', 1, 64),
			})
		}
		csvWriter.Flush()
		if err := csvWriter.Error(); err != nil {
			jsonErr(w, err, 500)
			return
		}
		filename := "sin-th2-history-" + time.Now().Format("20060102-150405") + ".csv"
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
		w.Header().Set("Content-Length", strconv.Itoa(out.Len()))
		_, _ = w.Write(out.Bytes())
	})

	http.HandleFunc("/api/sync-time", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			jsonErr(w, errors.New("POST required"), 405)
			return
		}
		t, err := dev.SyncTimeFiveMinutes()
		if err != nil {
			jsonErr(w, err, 500)
			return
		}
		jsonOut(w, map[string]any{
			"ok":         true,
			"deviceTime": t.Format("2006-01-02 15:04:05"),
			"interval":   300,
			"warning":    "0x11 clears device history",
		})
	})

	log.Printf("SIN-TH2 web: http://%s", *addr)
	log.Printf("Serial port: %s @ %d 8N1", *port, baudRate)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

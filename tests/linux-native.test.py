#!/usr/bin/env python3
"""Real helper integration in an isolated Xvfb desktop with one controlled window."""
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import zlib


ROOT = Path(__file__).resolve().parents[1]
TITLE = 'Ojousama native X11 fixture'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(read, ready, label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = read()
        if ready(result):
            return result
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for ' + label)


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


class Helper:
    def __init__(self, log):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / 'src/main/platform/screen-helper-linux.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            text=True, encoding='utf-8', bufsize=1,
        )
        self.id = 0

    def request(self, command, **arguments):
        self.id += 1
        self.process.stdin.write(json.dumps({'id': self.id, 'cmd': command, **arguments}) + '\n')
        self.process.stdin.flush()
        readable, _, _ = select.select([self.process.stdout], [], [], 20)
        require(readable, 'Screen helper did not answer ' + command)
        line = self.process.stdout.readline()
        require(line, 'Screen helper exited during ' + command)
        result = json.loads(line)
        require(result.get('id') == self.id, 'Helper returned a different request ID')
        require(result.get('ok'), command + ' failed: ' + result.get('error', 'unknown error'))
        return result


def synthetic_png(file):
    # A large, legible 5x7 raster word. No screenshots, fonts, Pillow or image tools.
    glyphs = {
        'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
        'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
        'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
        'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    }
    scale, margin = 12, 48
    width, height = (5 * 5 + 4) * scale + margin * 2, 7 * scale + margin * 2
    pixels = [bytearray([255] * width) for _ in range(height)]
    for i, letter in enumerate('HELLO'):
        for row, bits in enumerate(glyphs[letter]):
            for col, bit in enumerate(bits):
                if bit == '1':
                    for y in range(margin + row * scale, margin + (row + 1) * scale):
                        x = margin + (i * 6 + col) * scale
                        pixels[y][x:x + scale] = bytes(scale)

    def chunk(name, value):
        return struct.pack('>I', len(value)) + name + value + struct.pack('>I', zlib.crc32(name + value) & 0xFFFFFFFF)

    data = b''.join(b'\0' + row for row in pixels)
    file.write_bytes(b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)) +
        chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))


def fixture_identity(hwnd, pid):
    identity = subprocess.check_output(['xprop', '-id', str(hwnd), '_NET_WM_PID', 'WM_CLASS'], text=True)
    print('Fixture identity before EWMH setup: ' + identity.strip(), flush=True)
    match = re.search(r'_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)', identity)
    if match:
        require(int(match.group(1)) == pid, 'Fixture advertised a different process ID: ' + identity)
    else:
        require('_NET_WM_PID' in identity and ('not found' in identity or 'no such atom' in identity),
            'Unexpected PID property format: ' + identity)
        # Athena xmessage can omit this optional EWMH client property. Supply it
        # only for our known child; a mismatched existing PID must still fail.
        subprocess.run(['xprop', '-id', str(hwnd), '-f', '_NET_WM_PID', '32c', '-set', '_NET_WM_PID', str(pid)], check=True)
        subprocess.run(['xprop', '-id', str(hwnd), '-f', 'WM_CLIENT_MACHINE', '8s', '-set',
            'WM_CLIENT_MACHINE', socket.gethostname()], check=True)
    actual = subprocess.check_output(['xprop', '-id', str(hwnd), '_NET_WM_PID'], text=True)
    match = re.search(r'_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)', actual)
    require(match and int(match.group(1)) == pid, 'Fixture PID property was not established: ' + actual)


def main():
    require(sys.platform == 'linux', 'This native fixture requires Linux')
    require(os.environ.get('OJOUSAMA_NATIVE_X11_TEST') == '1' and os.environ.get('DISPLAY'),
        'Use: xvfb-run -a env OJOUSAMA_NATIVE_X11_TEST=1 python3 tests/linux-native.test.py')
    os.environ['XDG_SESSION_TYPE'] = 'x11'
    os.environ.pop('WAYLAND_DISPLAY', None)
    os.environ['LC_ALL'] = 'C'
    for command in ['openbox', 'xmessage', 'xwininfo', 'xprop', 'wmctrl', 'tesseract']:
        require(shutil.which(command), 'Missing native test dependency: ' + command)

    processes = []
    with tempfile.TemporaryDirectory(prefix='ojousama-native-x11-') as directory:
        with open(Path(directory, 'processes.log'), 'w+', encoding='utf-8') as log:
            try:
                wm = subprocess.Popen(['openbox', '--sm-disable'], stdout=log, stderr=log)
                processes.append(wm)
                helper = Helper(log)
                processes.append(helper.process)
                capabilities = wait_for(lambda: helper.request('capabilities'),
                    lambda value: value['foreground'] and value['windows'], 'an EWMH window manager')
                require(capabilities['session'] == 'x11' and capabilities['dependencies']['x11'], 'Native X11 was not detected')
                require(capabilities['ocr'] and 'eng' in capabilities['dependencies']['languages'], 'English Tesseract OCR data is required')

                window = subprocess.Popen(['xmessage', '-title', TITLE, '-name', 'ojousama-native-test',
                    '-geometry', '420x180+80+90', '-bw', '0', '-buttons', 'OK:0', 'Controlled native window'],
                    stdout=log, stderr=log)
                processes.append(window)
                listed = wait_for(lambda: helper.request('wins')['windows'],
                    lambda values: any(value['title'] == TITLE for value in values), 'the controlled X11 window')
                info = next(value for value in listed if value['title'] == TITLE)
                hwnd = info['hwnd']
                fixture_identity(hwnd, window.pid)
                info = next(value for value in helper.request('wins')['windows'] if value['hwnd'] == hwnd)
                require(hwnd > 0 and info['pid'] == window.pid and info['process'] == 'xmessage',
                    'Window identity did not match the fixture: ' + json.dumps({'got': info, 'expectedPid': window.pid}))

                # Compare to independent X11 utilities, including EWMH frame decorations.
                geometry = subprocess.check_output(['xwininfo', '-id', str(hwnd), '-stats'], text=True)
                values = {}
                for key in ['Absolute upper-left X', 'Absolute upper-left Y', 'Width', 'Height']:
                    match = re.search(re.escape(key) + r':\s*(-?\d+)', geometry)
                    require(match, 'xwininfo did not return ' + key)
                    values[key] = int(match.group(1))
                property_ = subprocess.check_output(['xprop', '-id', str(hwnd), '_NET_FRAME_EXTENTS'], text=True)
                match = re.search(r'=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)', property_)
                require(match, 'Openbox did not publish window frame extents')
                left, right, top, bottom = map(int, match.groups())
                expected = {'x': values['Absolute upper-left X'] - left, 'y': values['Absolute upper-left Y'] - top,
                    'w': values['Width'] + left + right, 'h': values['Height'] + top + bottom}
                require(all(info[key] == value for key, value in expected.items()), 'Helper bounds disagree with X11: ' + json.dumps({'got': info, 'expected': expected}))
                require(values['Width'] == 420 and values['Height'] == 180, 'Test window has unexpected client dimensions')

                subprocess.run(['wmctrl', '-i', '-a', hex(hwnd)], check=True)
                foreground = wait_for(lambda: helper.request('fg'), lambda value: value.get('hwnd') == hwnd, 'the fixture to receive focus')
                require(foreground['title'] == TITLE, 'Wrong foreground title')
                rectangle = helper.request('rect', hwnd=hwnd)
                require(not rectangle['gone'] and all(rectangle[key] == value for key, value in expected.items()), 'Window rect changed unexpectedly')
                require(any(value['title'] == TITLE for value in helper.request('procs', names=['xmessage'])['windows']), 'Process window lookup missed the fixture')
                require(helper.request('rect', hwnd=0xFFFFFFFF)['gone'], 'Unknown window handle was not reported gone')

                image = Path(directory, 'ocr.png')
                synthetic_png(image)
                text = helper.request('ocr', path=str(image), lang='en-US')['text']
                require('HELLO' in ''.join(text.split()).upper(), 'Synthetic OCR mismatch: ' + repr(text))
                print(json.dumps({'status': 'PASS', 'native': ['capabilities', 'foreground', 'windows', 'rect', 'procs', 'invalid-handle', 'OCR'],
                    'title': TITLE, 'bounds': expected, 'ocr': text.strip()}))
            except Exception:
                log.flush()
                log.seek(0)
                sys.stderr.write(log.read())
                raise
            finally:
                for process in reversed(processes):
                    stop(process)


if __name__ == '__main__':
    main()

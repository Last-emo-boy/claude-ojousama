#!/usr/bin/env python3
"""JSONL window metadata via X11/EWMH and optional local Tesseract OCR."""
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


class WindowAttributes(C.Structure):
    _fields_ = [
        ('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int),
        ('border_width', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p),
        ('root', C.c_ulong), ('window_class', C.c_int), ('bit_gravity', C.c_int),
        ('win_gravity', C.c_int), ('backing_store', C.c_int),
        ('backing_planes', C.c_ulong), ('backing_pixel', C.c_ulong),
        ('save_under', C.c_int), ('colormap', C.c_ulong), ('map_installed', C.c_int),
        ('map_state', C.c_int), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long),
        ('override_redirect', C.c_int), ('screen', C.c_void_p),
    ]


class XErrorEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('display', C.c_void_p),
        ('resourceid', C.c_ulong), ('serial', C.c_ulong),
        ('error_code', C.c_ubyte), ('request_code', C.c_ubyte), ('minor_code', C.c_ubyte)]


class X11:
    def __init__(self):
        name = ctypes.util.find_library('X11')
        if not name:
            raise RuntimeError('libX11 is not installed')
        self.lib = C.CDLL(name)
        signatures = {
            'XOpenDisplay': ([C.c_char_p], C.c_void_p),
            'XCloseDisplay': ([C.c_void_p], C.c_int),
            'XDefaultRootWindow': ([C.c_void_p], C.c_ulong),
            'XInternAtom': ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong),
            'XGetWindowProperty': ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_long,
                C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong),
                C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong),
                C.POINTER(C.POINTER(C.c_ubyte))], C.c_int),
            'XGetWindowAttributes': ([C.c_void_p, C.c_ulong, C.POINTER(WindowAttributes)], C.c_int),
            'XTranslateCoordinates': ([C.c_void_p, C.c_ulong, C.c_ulong,
                C.c_int, C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int),
                C.POINTER(C.c_ulong)], C.c_int),
            'XFree': ([C.c_void_p], C.c_int),
            'XSetErrorHandler': ([C.c_void_p], C.c_void_p),
        }
        for key, (args, result) in signatures.items():
            function = getattr(self.lib, key)
            function.argtypes, function.restype = args, result
        # Windows can disappear between the EWMH list and metadata requests.
        # Xlib's default BadWindow handler terminates the helper in that race.
        self.last_error = 0
        def on_error(_display, event):
            self.last_error = C.cast(event, C.POINTER(XErrorEvent)).contents.error_code
            return 0
        self._error_handler = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(on_error)
        self.lib.XSetErrorHandler(C.cast(self._error_handler, C.c_void_p))
        self.display = self.lib.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError('Cannot connect to the X11 display')
        self.root = self.lib.XDefaultRootWindow(self.display)
        self.atoms = {}

    def close(self):
        if self.display:
            self.lib.XCloseDisplay(self.display)
            self.display = None

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.lib.XInternAtom(self.display, name.encode('ascii'), False)
        return self.atoms[name]

    def prop(self, window, name):
        actual_type, length, remaining = C.c_ulong(), C.c_ulong(), C.c_ulong()
        format_ = C.c_int()
        value = C.POINTER(C.c_ubyte)()
        self.last_error = 0
        status = self.lib.XGetWindowProperty(self.display, window, self.atom(name),
            0, 4096, False, 0, C.byref(actual_type), C.byref(format_),
            C.byref(length), C.byref(remaining), C.byref(value))
        try:
            if not self.check_window() or status or not value:
                return None
            if format_.value == 8:
                return C.string_at(value, length.value)
            # Xlib expands format-32 properties to native unsigned longs on LP64.
            if format_.value == 32:
                return [number & 0xFFFFFFFF for number in C.cast(value, C.POINTER(C.c_ulong))[:length.value]]
            if format_.value == 16:
                return list(C.cast(value, C.POINTER(C.c_ushort))[:length.value])
            return None
        finally:
            if value:
                self.lib.XFree(value)

    def check_window(self):
        if self.last_error and self.last_error != 3:  # BadWindow is an expected window-close race.
            raise RuntimeError('X11 request failed with error ' + str(self.last_error))
        return not self.last_error

    def numbers(self, window, name):
        value = self.prop(window, name)
        return value if isinstance(value, list) else []

    def text(self, window, name):
        value = self.prop(window, name)
        return value.decode('utf-8', errors='replace').rstrip('\0') if isinstance(value, bytes) else ''

    def supported(self, name):
        return self.atom(name) in self.numbers(self.root, '_NET_SUPPORTED')

    def info(self, hwnd):
        attributes = WindowAttributes()
        self.last_error = 0
        exists = self.lib.XGetWindowAttributes(self.display, hwnd, C.byref(attributes))
        if not self.check_window() or not exists:
            return None
        x, y, child = C.c_int(), C.c_int(), C.c_ulong()
        self.last_error = 0
        translated = self.lib.XTranslateCoordinates(self.display, hwnd, self.root, 0, 0,
                C.byref(x), C.byref(y), C.byref(child))
        if not self.check_window() or not translated:
            return None
        extents = self.numbers(hwnd, '_NET_FRAME_EXTENTS')
        left, right, top, bottom = extents[:4] if len(extents) >= 4 else (0, 0, 0, 0)
        states = self.numbers(hwnd, '_NET_WM_STATE')
        wm_state = self.numbers(hwnd, 'WM_STATE')
        minimized = self.atom('_NET_WM_STATE_HIDDEN') in states or (wm_state and wm_state[0] == 3)
        pids = self.numbers(hwnd, '_NET_WM_PID')
        pid = pids[0] if pids else 0
        classes = self.text(hwnd, 'WM_CLASS').split('\0')
        cls = classes[-1] if classes else ''
        process = cls or (classes[0] if classes else '')
        if pid:
            try:
                process = Path('/proc', str(pid), 'comm').read_text(errors='replace').strip()
            except OSError:
                pass  # The process may have exited after its window was listed.
        types = self.numbers(hwnd, '_NET_WM_WINDOW_TYPE')
        shell = any(self.atom('_NET_WM_WINDOW_TYPE_' + kind) in types for kind in ('DESKTOP', 'DOCK'))
        return {
            'hwnd': hwnd, 'title': self.text(hwnd, '_NET_WM_NAME') or self.text(hwnd, 'WM_NAME'),
            'process': process, 'cls': cls, 'pid': pid, 'shell': shell,
            'x': x.value - left, 'y': y.value - top,
            'w': attributes.width + left + right, 'h': attributes.height + top + bottom,
            'minimized': bool(minimized), 'visible': attributes.map_state == 2,
            'maximized': all(self.atom('_NET_WM_STATE_MAXIMIZED_' + axis) in states for axis in ('VERT', 'HORZ')),
        }

    def windows(self):
        if not self.supported('_NET_CLIENT_LIST_STACKING'):
            raise RuntimeError('Window enumeration requires an EWMH window manager')
        # EWMH stacking order is bottom-to-top; seats require top-to-bottom.
        ids = reversed(self.numbers(self.root, '_NET_CLIENT_LIST_STACKING'))
        current = self.numbers(self.root, '_NET_CURRENT_DESKTOP')
        windows = []
        for hwnd in ids:
            desktops = self.numbers(hwnd, '_NET_WM_DESKTOP')
            if current and desktops and desktops[0] not in (current[0], 0xFFFFFFFF):
                continue
            info = self.info(hwnd)
            if info and info['visible'] and not info['minimized'] and info['w'] >= 60 and info['h'] >= 40:
                windows.append(info)
            if len(windows) == 48:
                break
        return windows


class LinuxScreen:
    def __init__(self):
        wayland = os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland' or bool(os.environ.get('WAYLAND_DISPLAY'))
        self.session = 'wayland' if wayland else ('x11' if os.environ.get('DISPLAY') else 'headless')
        self.x11 = None
        self.reason = ''
        if sys.platform != 'linux':
            self.reason = 'The Linux screen helper requires Linux'
        elif self.session == 'wayland':
            self.reason = 'Wayland does not expose global foreground windows; use the screen-sharing picker'
        elif self.session == 'headless':
            self.reason = 'No graphical DISPLAY is available'
        else:
            try:
                self.x11 = X11()
            except (OSError, RuntimeError) as error:
                self.reason = str(error)
        self.tesseract = shutil.which('tesseract')

    def languages(self):
        if not self.tesseract:
            return []
        result = subprocess.run([self.tesseract, '--list-langs'], capture_output=True,
            text=True, encoding='utf-8', errors='replace', timeout=5, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'Tesseract could not list its languages')
        return [line.strip() for line in result.stdout.splitlines()
                if line.strip() and all(character.isalnum() or character in '_/' for character in line.strip())
                and line.strip() != 'osd']

    def capabilities(self):
        self.tesseract = shutil.which('tesseract')
        languages, ocr_reason = [], ''
        try:
            languages = self.languages()
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            ocr_reason = str(error)
        if not self.tesseract:
            ocr_reason = '未安装 Tesseract；安装后可启用本地 OCR，并添加所需语言包'
        elif not languages and not ocr_reason:
            ocr_reason = 'Tesseract 尚未安装文字识别语言包'
        foreground = bool(self.x11 and self.x11.supported('_NET_ACTIVE_WINDOW'))
        windows = bool(self.x11 and self.x11.supported('_NET_CLIENT_LIST_STACKING'))
        reason = self.reason
        if self.x11 and not (foreground and windows):
            reason = 'Foreground tracking and window seats require an EWMH window manager'
        return {
            'ok': True, 'platform': 'linux', 'session': self.session,
            'foreground': foreground, 'windows': windows, 'ocr': bool(languages),
            'manualCapture': self.session != 'headless', 'reason': reason,
            'ocrReason': ocr_reason, 'coordinates': 'physical',
            'dependencies': {'python': True, 'x11': bool(self.x11),
                'tesseract': bool(self.tesseract), 'languages': languages},
        }

    def ocr(self, file, lang):
        self.tesseract = shutil.which('tesseract')
        if not self.tesseract:
            raise RuntimeError('Tesseract OCR is not installed')
        image = Path(file).resolve(strict=True)
        if not image.is_file():
            raise ValueError('OCR requires an image file')
        available = self.languages()
        if not available:
            raise RuntimeError('Tesseract has no text-recognition language data installed')
        requested = ['eng'] if lang.startswith('en') else ['chi_sim', 'eng']
        selected = [name for name in requested if name in available]
        if not selected:
            raise RuntimeError('Requested OCR language is unavailable: ' + '+'.join(requested))
        result = subprocess.run([self.tesseract, str(image), 'stdout', '-l', '+'.join(selected)],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=12, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'Tesseract OCR failed')
        return {'ok': True, 'text': result.stdout, 'language': '+'.join(selected)}

    def request(self, request):
        command = request.get('cmd')
        if command == 'ping':
            return {'ok': True}
        if command == 'capabilities':
            return self.capabilities()
        if command == 'ocr':
            return self.ocr(str(request.get('path', '')), str(request.get('lang', 'auto')))
        if command not in ('fg', 'wins', 'rect', 'procs'):
            raise ValueError('Unknown command: ' + str(command))
        if not self.x11:
            raise RuntimeError(self.reason or 'X11 window metadata is unavailable')
        if command == 'fg':
            if not self.x11.supported('_NET_ACTIVE_WINDOW'):
                raise RuntimeError('Foreground tracking requires an EWMH window manager')
            ids = self.x11.numbers(self.x11.root, '_NET_ACTIVE_WINDOW')
            info = self.x11.info(ids[0]) if ids and ids[0] else None
            return {'ok': True, **info} if info else {'ok': True, 'none': True}
        if command == 'rect':
            hwnd = int(request.get('hwnd', 0))
            if hwnd <= 0 or hwnd > 0xFFFFFFFF:
                raise ValueError('Invalid window handle')
            info = self.x11.info(hwnd)
            return {'ok': True, 'gone': False, **info} if info else {'ok': True, 'gone': True}
        windows = self.x11.windows()
        if command == 'procs':
            names = request.get('names', [])
            if not isinstance(names, list):
                raise ValueError('Process names must be an array')
            names = {str(name).lower() for name in names}
            windows = [{'process': w['process'], 'title': w['title']} for w in windows
                       if w['process'].lower() in names and w['title']]
        return {'ok': True, 'windows': windows}

    def close(self):
        if self.x11:
            self.x11.close()


def main():
    helper = LinuxScreen()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError('Request must be a JSON object')
                response = helper.request(request)
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                response = {'ok': False, 'error': str(error)}
            response['id'] = request.get('id') if isinstance(request, dict) else None
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        helper.close()


if __name__ == '__main__':
    main()

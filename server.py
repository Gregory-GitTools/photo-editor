"""Локальный статический сервер для Albom — как `python -m http.server`, но с одним
дополнительным маршрутом: открыть папку в Проводнике Windows по двойному клику в дереве
папок приложения. Это невозможно сделать чистым JS (File System Access API намеренно не
отдаёт странице реальный путь к файлу на диске), поэтому путь строится в браузере и
передаётся сюда, а сервер уже сам запускает explorer.exe.
"""

import ctypes
import http.server
import json
import os
import re
import socketserver
import subprocess
import threading
import time
from ctypes import wintypes

PORT = 8642
ALLOWED_ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
WINDOWS_ABS_PATH_RE = re.compile(r"^[a-zA-Z]:[\\/]")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _explorer_window_handles():
    # окна Проводника — отдельный класс "CabinetWClass"; ищем видимые, чтобы не путать
    # со свёрнутыми в трей/скрытыми служебными окнами оболочки
    hwnds = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value == "CabinetWClass":
                hwnds.append(hwnd)
        return True

    user32.EnumWindows(_WNDENUMPROC(cb), 0)
    return set(hwnds)


def _force_foreground(hwnd):
    SW_RESTORE = 9
    user32.ShowWindow(hwnd, SW_RESTORE)  # на случай, если новое окно открылось свёрнутым
    fg_hwnd = user32.GetForegroundWindow()
    cur_thread = kernel32.GetCurrentThreadId()
    fg_thread = user32.GetWindowThreadProcessId(fg_hwnd, None)
    # Windows нарочно не даёт фоновым процессам красть фокус (foreground lock) — стандартный
    # обход по MSDN: временно "приклеить" очередь ввода нашего потока к активному окну,
    # тогда SetForegroundWindow для нашего окна перестаёт блокироваться
    attached = user32.AttachThreadInput(cur_thread, fg_thread, True)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    if attached:
        user32.AttachThreadInput(cur_thread, fg_thread, False)


def open_folder_focused(path):
    before = _explorer_window_handles()
    user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    subprocess.Popen(["explorer", path])  # без shell=True — без риска инъекции команд

    # окна Проводника — одна оболочка на все папки, поэтому новое окно может переиспользовать
    # уже запущенный процесс explorer.exe; ждём появления нового hwnd, а не завершения процесса
    deadline = time.time() + 3.0
    new_hwnd = None
    while time.time() < deadline and not new_hwnd:
        time.sleep(0.1)
        diff = _explorer_window_handles() - before
        if diff:
            new_hwnd = next(iter(diff))
    if new_hwnd:
        _force_foreground(new_hwnd)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/__open_in_explorer":
            self.send_error(404)
            return

        # проверка Origin — иначе любая сторонняя открытая вкладка могла бы дёрнуть
        # localhost:8642 и заставить explorer.exe открыть произвольный путь/URL
        origin = self.headers.get("Origin", "")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_error(403, "Forbidden origin")
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
            path = data.get("path", "")
        except (ValueError, TypeError):
            self.send_error(400, "Bad JSON")
            return

        # только настоящий абсолютный путь Windows (никаких "http://", UNC-триков и т.п.,
        # которые explorer.exe трактует как команду открыть браузер/сеть)
        if not WINDOWS_ABS_PATH_RE.match(path) or not os.path.isdir(path):
            self.send_error(400, "Not an existing local directory")
            return

        # поиск нового окна и перехват фокуса занимают до пары секунд — не задерживаем ответ
        # браузеру и не блокируем однопоточный сервер на это время
        threading.Thread(target=open_folder_focused, args=(path,), daemon=True).start()
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # тише — не засоряем консоль обычными GET на каждый файл альбома


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Albom: http://localhost:{PORT}/")
        httpd.serve_forever()

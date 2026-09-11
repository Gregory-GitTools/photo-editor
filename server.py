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
import sys
import threading
import time
from ctypes import wintypes

# консоль Windows по умолчанию в кодировке cp1251 — падает на некоторых символах в именах
# папок (напр. "õ", "ü"), что раньше убивало поток open_folder_focused на самом print()
sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

PORT = 8642
ALLOWED_ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
WINDOWS_ABS_PATH_RE = re.compile(r"^[a-zA-Z]:[\\/]")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _title_matches_folder(title, folder_name):
    # заголовок окна Проводника — это НЕ просто имя папки, а "<путь-или-имя> — Проводник" (текст
    # после тире зависит от языка Windows, а видимая часть пути — от настроек/версии Проводника,
    # напр. "E:\...\Имя папки — проводник"), поэтому точное сравнение с именем папки никогда не
    # совпадало. Сравниваем только последний сегмент пути перед этим суффиксом
    head = title.rsplit(" — ", 1)[0].rstrip()
    last_segment = head.rsplit("\\", 1)[-1]
    return last_segment == folder_name


def _find_explorer_window_by_title(folder_name):
    # окна Проводника — отдельный класс "CabinetWClass"; ищем видимые, чтобы не путать
    # со свёрнутыми в трей/скрытыми служебными окнами оболочки (см. _title_matches_folder
    # про формат заголовка; см. open_folder_focused про то, откуда берётся folder_name)
    matches = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value == "CabinetWClass":
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, buf, 512)
                if _title_matches_folder(buf.value, folder_name):
                    matches.append(hwnd)
        return True

    user32.EnumWindows(_WNDENUMPROC(cb), 0)
    return matches[0] if matches else None


def _list_explorer_window_titles():
    # диагностика: что реально видно в системе на момент неудачного поиска по заголовку
    titles = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value == "CabinetWClass":
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, buf, 512)
                titles.append(buf.value)
        return True

    user32.EnumWindows(_WNDENUMPROC(cb), 0)
    return titles


def _force_foreground(hwnd):
    SW_RESTORE = 9
    VK_MENU = 0x12
    KEYEVENTF_KEYUP = 0x0002
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_SHOWWINDOW = 0x0040

    user32.ShowWindow(hwnd, SW_RESTORE)  # на случай, если новое окно открылось свёрнутым

    # одного AttachThreadInput недостаточно — на части систем окно всплывает на передний план
    # лишь на мгновение и тут же уходит обратно под окно браузера. Добавляем ещё два стандартных
    # трюка обхода foreground lock: (1) имитация нажатия Alt сбрасывает внутренний таймер блокировки
    # переключения фокуса, (2) кратковременная пометка окна "поверх всех" и снятие этой пометки
    # физически перемещает его на самый верх Z-порядка, а не просто просит систему дать ему фокус
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)

    fg_hwnd = user32.GetForegroundWindow()
    cur_thread = kernel32.GetCurrentThreadId()
    fg_thread = user32.GetWindowThreadProcessId(fg_hwnd, None)
    # Windows нарочно не даёт фоновым процессам красть фокус (foreground lock) — стандартный
    # обход по MSDN: временно "приклеить" очередь ввода нашего потока к активному окну,
    # тогда SetForegroundWindow для нашего окна перестаёт блокироваться
    attached = user32.AttachThreadInput(cur_thread, fg_thread, True)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    if attached:
        user32.AttachThreadInput(cur_thread, fg_thread, False)

    # SetForegroundWindow часто молча отклоняется системой для процессов без "прав" на кражу
    # фокуса (см. foreground lock). SwitchToThisWindow — недокументированный, но давно используемый
    # инструментами вроде AutoHotkey вызов: им пользуется сама панель задач/Alt+Tab, и он игнорирует
    # те же ограничения, что блокируют обычный SetForegroundWindow
    user32.SwitchToThisWindow(hwnd, True)


def open_folder_focused(path):
    # заголовок окна/вкладки Проводника — имя открытой папки (последний компонент пути)
    target_title = os.path.basename(path.rstrip("\\/")) or path
    user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    subprocess.Popen(["explorer", path])  # без shell=True — без риска инъекции команд

    # раньше ждали появления НОВОГО hwnd — но если в Windows 11 включены вкладки Проводника
    # и окно уже открыто, путь может открыться вкладкой в уже существующем окне: новый hwnd
    # не появляется, и окно так и остаётся не выведенным на передний план (визуально —
    # "ничего не произошло", хотя вкладка на самом деле открылась). Ищем по заголовку окна —
    # он обновляется на имя папки в обоих случаях (новое окно или новая вкладка в старом)
    deadline = time.time() + 3.0
    hwnd = None
    while time.time() < deadline and not hwnd:
        time.sleep(0.1)
        hwnd = _find_explorer_window_by_title(target_title)
    if hwnd:
        _force_foreground(hwnd)
    else:
        # не должно происходить при рабочем сопоставлении заголовков — если всё же случилось,
        # печатаем видимые заголовки окон Проводника, чтобы было с чем сравнивать при разборе
        print(f"[explorer-focus] окно для {target_title!r} не найдено; видимые окна Проводника: {_list_explorer_window_titles()!r}", flush=True)


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

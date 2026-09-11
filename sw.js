// Пустой service worker — не нужен для офлайн-кэша (приложение и так работает полностью
// локально, без сети), но некоторые версии Chrome/Edge требуют зарегистрированный
// service worker с обработчиком fetch как одно из условий показа beforeinstallprompt
// (см. install-btn в app.js). Ничего не кэширует, не перехватывает ответы.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (evt) => evt.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

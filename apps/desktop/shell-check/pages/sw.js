// A service worker no page may register. If one ever registered, it would sit in front of every
// page of the origin, Settings included.
self.addEventListener('fetch', () => {});

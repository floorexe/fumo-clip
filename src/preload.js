const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['clip:added', 'clip:updated', 'library:changed', 'obs:status', 'export:progress', 'toast', 'update:status', 'import:progress', 'import:done']);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
  on: (ch, cb) => {
    if (!EVENTS.has(ch)) throw new Error('unknown event ' + ch);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  startDrag: (id) => ipcRenderer.send('drag:start', id),
  dragShare: (file, id) => ipcRenderer.send('drag:share', file, id),
});

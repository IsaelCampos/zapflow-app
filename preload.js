const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Janela
  minimize:  () => ipcRenderer.send('window-minimize'),
  maximize:  () => ipcRenderer.send('window-maximize'),
  close:     () => ipcRenderer.send('window-close'),

  // Excel
  chooseFile: ()            => ipcRenderer.invoke('choose-file'),
  readExcel:  (path, sheet) => ipcRenderer.invoke('read-excel', path, sheet),

  // WhatsApp
  connectWhatsApp:    ()    => ipcRenderer.invoke('connect-whatsapp'),
  disconnectWhatsApp: ()    => ipcRenderer.invoke('disconnect-whatsapp'),
  startSending: (opts)      => ipcRenderer.invoke('start-sending', opts),
  cancelSending: ()         => ipcRenderer.send('cancel-sending'),

  // Histórico
  getHistory: ()            => ipcRenderer.invoke('get-history'),

  // Licença
  getMachineInfo:    ()     => ipcRenderer.invoke('get-machine-info'),
  salvarLicenca:  (dados)   => ipcRenderer.invoke('salvar-licenca', dados),
  licencaConfirmada: ()     => ipcRenderer.invoke('licenca-confirmada'),

  // Logs e exportação
  getLogs:         ()       => ipcRenderer.invoke('get-logs'),
  readLog:   (caminho)      => ipcRenderer.invoke('read-log', caminho),
  exportarCSV: (sessaoId)   => ipcRenderer.invoke('exportar-csv', sessaoId),
  abrirPastaLogs: ()        => ipcRenderer.invoke('abrir-pasta-logs'),

  // Eventos do main → renderer
  on: (channel, fn) => {
    const allowed = [
      'wa-qr', 'wa-authenticated', 'wa-ready', 'wa-disconnected', 'wa-error',
      'sending-progress', 'sending-countdown', 'sending-done',
      'licenca-status'
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args));
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
});
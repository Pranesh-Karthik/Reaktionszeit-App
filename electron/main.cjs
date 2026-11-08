const { app, BrowserWindow, ipcMain, screen } = require('electron');
const ExcelJS = require('exceljs');
const os = require('node:os');
const path = require('node:path');

const worksheetName = 'Ergebnisse';
const headers = [
  'Durchgangs-ID',
  'Teilnehmer-ID',
  'Name',
  'Testart',
  'Reaktionszeit (ms)',
  'Datum und Uhrzeit',
  'Bildschirmfrequenz (Hz)',
  'Nominales Bildintervall (ms)',
  'CPU-Modell',
  'Gemeldeter CPU-Takt (MHz)',
  'Logische Prozessorkerne',
  'Arbeitsspeicher (GB)',
  'Betriebssystem',
  'Zeitmesshinweis',
];

let mainWindow;

function resultsFilePath() {
  return path.join(app.getPath('documents'), 'Reaktionszeit-App', 'Ergebnisse.xlsx');
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Nicht erlaubter App-Aufruf.');
  }
}

function readDeviceInfo() {
  const display = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const frequency = Number(display.displayFrequency) || null;
  const cpu = os.cpus()[0];

  return {
    operatingSystem: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    cpuModel: cpu?.model || 'Nicht verfügbar',
    cpuSpeedMhz: Number(cpu?.speed) || null,
    logicalCores: os.cpus().length,
    memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    displayRefreshRateHz: frequency,
    nominalFrameIntervalMs: frequency ? Number((1000 / frequency).toFixed(2)) : null,
    audioLatency: 'Nicht ermittelt',
    timingNote: 'Softwarezeit; nicht extern kalibriert',
  };
}

function getWorksheet(workbook) {
  let sheet = workbook.getWorksheet(worksheetName);
  if (!sheet) {
    sheet = workbook.addWorksheet(worksheetName);
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return sheet;
}

async function loadWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const filePath = resultsFilePath();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return workbook;
}

function cleanText(value, label, maxLength = 120) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} fehlt.`);
  }
  return value.trim().slice(0, maxLength);
}

function validateResult(value) {
  if (!value || typeof value !== 'object') throw new Error('Ergebnis ist ungültig.');
  const testType = cleanText(value.testType, 'Testart', 30);
  if (!['Visuell', 'Akustisch'].includes(testType)) {
    throw new Error('Unbekannte Testart.');
  }
  const reactionTimeMs = Number(value.reactionTimeMs);
  if (!Number.isFinite(reactionTimeMs) || reactionTimeMs <= 0 || reactionTimeMs > 60000) {
    throw new Error('Die Reaktionszeit ist ungültig.');
  }
  const device = value.device && typeof value.device === 'object' ? value.device : {};

  return {
    runId: cleanText(value.runId, 'Durchgangs-ID', 80),
    participantId: cleanText(value.participantId, 'Teilnehmer-ID', 80),
    participantName: cleanText(value.participantName, 'Name', 120),
    testType,
    reactionTimeMs: Number(reactionTimeMs.toFixed(2)),
    timestamp: cleanText(value.timestamp, 'Zeitstempel', 50),
    device,
  };
}

function worksheetRecords(sheet) {
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values;
    if (values[1]) {
      rows.push({
        runId: String(values[1]),
        participantId: String(values[2] ?? ''),
        participantName: String(values[3] ?? ''),
        testType: String(values[4] ?? ''),
        reactionTimeMs: Number(values[5]),
        timestamp: String(values[6] ?? ''),
      });
    }
  });
  return rows;
}

function registerIpcHandlers() {
  ipcMain.handle('device:get-info', (event) => {
    assertTrustedSender(event);
    return readDeviceInfo();
  });

  ipcMain.handle('results:load', async (event) => {
    assertTrustedSender(event);
    const workbook = await loadWorkbook();
    const sheet = workbook.getWorksheet(worksheetName);
    return {
      filePath: resultsFilePath(),
      records: sheet ? worksheetRecords(sheet) : [],
    };
  });

  ipcMain.handle('results:save', async (event, rawResult) => {
    assertTrustedSender(event);
    const result = validateResult(rawResult);
    const workbook = await loadWorkbook();
    const sheet = getWorksheet(workbook);
    const device = result.device;
    sheet.addRow([
      result.runId,
      result.participantId,
      result.participantName,
      result.testType,
      result.reactionTimeMs,
      result.timestamp,
      Number(device.displayRefreshRateHz) || null,
      Number(device.nominalFrameIntervalMs) || null,
      String(device.cpuModel || 'Nicht verfügbar'),
      Number(device.cpuSpeedMhz) || null,
      Number(device.logicalCores) || null,
      Number(device.memoryGb) || null,
      String(device.operatingSystem || 'Nicht verfügbar'),
      String(device.timingNote || 'Softwarezeit; nicht extern kalibriert'),
    ]);
    sheet.columns = headers.map((header) => ({ header, width: Math.max(18, header.length + 2) }));

    const filePath = resultsFilePath();
    await require('node:fs/promises').mkdir(path.dirname(filePath), { recursive: true });
    await workbook.xlsx.writeFile(filePath);
    return { saved: true, filePath, record: result };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 780,
    minHeight: 620,
    title: 'Reaktionszeit-App',
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    let isAllowedDevUrl = false;
    try {
      isAllowedDevUrl = new URL(targetUrl).origin === 'http://127.0.0.1:5173';
    } catch {
      isAllowedDevUrl = false;
    }
    if (process.env.APP_ENV !== 'development' || !isAllowedDevUrl) {
      event.preventDefault();
    }
  });

  if (process.env.APP_ENV === 'development') {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

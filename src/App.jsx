import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const testLabels = {
  visual: 'Visuell',
  audio: 'Akustisch',
};

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

function getMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export default function App() {
  const [participantName, setParticipantName] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [testType, setTestType] = useState('visual');
  const [phase, setPhase] = useState('idle');
  const [device, setDevice] = useState(null);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const [latestResult, setLatestResult] = useState(null);
  const [filePath, setFilePath] = useState('');
  const [isAudioReady, setIsAudioReady] = useState(true);
  const timerRef = useRef(null);
  const phaseRef = useRef('idle');
  const stimulusAtRef = useRef(null);
  const audioContextRef = useRef(null);
  const pendingResultRef = useRef(null);

  const transitionTo = useCallback((nextPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const refreshRecords = useCallback(async () => {
    try {
      const result = await window.reactionApp.loadResults();
      setRecords(result.records || []);
      setFilePath(result.filePath || '');
    } catch (loadError) {
      setError(`Ergebnisse konnten nicht geladen werden: ${loadError.message}`);
    }
  }, []);

  useEffect(() => {
    window.reactionApp.getDeviceInfo()
      .then(setDevice)
      .catch((deviceError) => setError(`Geräteinformationen nicht verfügbar: ${deviceError.message}`));
    refreshRecords();
  }, [refreshRecords]);

  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    audioContextRef.current?.close().catch(() => {});
  }, []);

  const currentRecords = useMemo(() => {
    const id = participantId.trim();
    if (!id) return [];
    return records.filter((record) => record.participantId === id);
  }, [participantId, records]);

  const statistics = useMemo(() => Object.fromEntries(
    Object.entries(testLabels).map(([key, label]) => {
      const values = currentRecords
        .filter((record) => record.testType === label)
        .map((record) => Number(record.reactionTimeMs))
        .filter(Number.isFinite);
      return [key, {
        count: values.length,
        mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        median: getMedian(values),
      }];
    }),
  ), [currentRecords]);

  const startAudioSignal = useCallback(async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Audioausgabe wird auf diesem Gerät nicht unterstützt.');

    const context = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = context;
    await context.resume();

    const startAt = context.currentTime + 0.12;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.01);
    gain.gain.setValueAtTime(0.18, startAt + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.19);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.2);

    // Map the scheduled Web Audio time to the app clock where the browser supports it.
    if (typeof context.getOutputTimestamp === 'function') {
      const outputClock = context.getOutputTimestamp();
      stimulusAtRef.current = Number.isFinite(outputClock.performanceTime) && outputClock.performanceTime > 0
        ? outputClock.performanceTime + ((startAt - outputClock.contextTime) * 1000)
        : performance.now() + 120;
    } else {
      stimulusAtRef.current = performance.now() + 120;
    }
    const waitUntilOutputMs = Math.max(0, stimulusAtRef.current - performance.now());
    timerRef.current = window.setTimeout(() => transitionTo('signal'), waitUntilOutputMs);
  }, [transitionTo]);

  const triggerSignal = useCallback(async () => {
    if (testType === 'audio') {
      try {
        await startAudioSignal();
        setIsAudioReady(true);
      } catch (signalError) {
        setIsAudioReady(false);
        setError(`Ton konnte nicht gestartet werden: ${signalError.message}`);
        transitionTo('idle');
      }
      return;
    }

    window.requestAnimationFrame(() => {
      stimulusAtRef.current = performance.now();
      transitionTo('signal');
    });
  }, [startAudioSignal, testType, transitionTo]);

  const startTest = async () => {
    if (!participantName.trim() || !participantId.trim()) {
      setError('Bitte zuerst Name und ID ausfüllen.');
      return;
    }
    setError('');
    setLatestResult(null);
    setIsAudioReady(true);
    stimulusAtRef.current = null;

    if (testType === 'audio') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        setIsAudioReady(false);
        setError('Audioausgabe wird auf diesem Gerät nicht unterstützt.');
        return;
      }
      try {
        audioContextRef.current = audioContextRef.current || new AudioContextClass();
        await audioContextRef.current.resume();
      } catch (audioError) {
        setIsAudioReady(false);
        setError(`Audioausgabe konnte nicht vorbereitet werden: ${audioError.message}`);
        return;
      }
    }

    transitionTo('waiting');

    // The delay is randomized to make the cue less predictable; the range is a prototype setting.
    const delay = 1500 + Math.random() * 2000;
    timerRef.current = window.setTimeout(triggerSignal, delay);
  };

  const saveResponse = useCallback(async () => {
    if (phaseRef.current !== 'signal' || stimulusAtRef.current === null) return;
    const reactionTimeMs = performance.now() - stimulusAtRef.current;
    transitionTo('saving');
    setError('');

    const result = {
      runId: crypto.randomUUID(),
      participantId: participantId.trim(),
      participantName: participantName.trim(),
      testType: testLabels[testType],
      reactionTimeMs,
      timestamp: new Date().toISOString(),
      device: device || {},
    };
    pendingResultRef.current = result;

    try {
      const saved = await window.reactionApp.saveResult(result);
      setLatestResult(saved.record);
      setFilePath(saved.filePath);
      setRecords((previous) => [...previous, {
        runId: saved.record.runId,
        participantId: saved.record.participantId,
        participantName: saved.record.participantName,
        testType: saved.record.testType,
        reactionTimeMs: saved.record.reactionTimeMs,
        timestamp: saved.record.timestamp,
      }]);
      pendingResultRef.current = null;
      transitionTo('done');
    } catch (saveError) {
      setError(`Speichern fehlgeschlagen: ${saveError.message}. Schließe die Excel-Datei und versuche es erneut.`);
      transitionTo('save-error');
    }
  }, [device, participantId, participantName, testType, transitionTo]);

  const retrySave = async () => {
    if (!pendingResultRef.current) return;
    transitionTo('saving');
    setError('');
    try {
      const saved = await window.reactionApp.saveResult(pendingResultRef.current);
      setLatestResult(saved.record);
      setFilePath(saved.filePath);
      await refreshRecords();
      pendingResultRef.current = null;
      transitionTo('done');
    } catch (saveError) {
      setError(`Speichern fehlgeschlagen: ${saveError.message}.`);
      transitionTo('save-error');
    }
  };

  const cancelTest = () => {
    window.clearTimeout(timerRef.current);
    stimulusAtRef.current = null;
    transitionTo('idle');
    setError('Durchgang abgebrochen.');
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
      if (phaseRef.current === 'signal') {
        event.preventDefault();
        saveResponse();
      } else if (phaseRef.current === 'waiting') {
        event.preventDefault();
        window.clearTimeout(timerRef.current);
        stimulusAtRef.current = null;
        transitionTo('idle');
        setError('Zu früh gedrückt. Bitte starte den Durchgang erneut.');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveResponse, transitionTo]);

  const isActive = ['waiting', 'signal', 'saving'].includes(phase);
  const cueActive = phase === 'signal' && testType === 'visual';

  return (
    <main className={`app-shell ${cueActive ? 'cue-active' : ''}`}>
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">R</div>
        <div>
          <p className="eyebrow">COLLEGE-PROJEKT</p>
          <h1>Reaktionszeit</h1>
        </div>
        <div className="local-badge"><span /> Lokale Speicherung</div>
      </header>

      <div className="content-grid">
        <section className="main-column">
          <div className="intro-block">
            <p className="eyebrow">TESTDURCHGANG</p>
            <h2>Bereit für den nächsten Reiz?</h2>
            <p>Wähle einen Test. Reagiere so schnell wie möglich mit der Leertaste oder der Schaltfläche.</p>
          </div>

          <section className="panel participant-panel" aria-labelledby="participant-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">TEILNEHMENDE PERSON</p>
                <h3 id="participant-title">Angaben</h3>
              </div>
              <span className="step-indicator">01</span>
            </div>
            <div className="field-row">
              <label>
                Name <span className="required">*</span>
                <input
                  autoComplete="off"
                  disabled={isActive}
                  maxLength={120}
                  onChange={(event) => setParticipantName(event.target.value)}
                  placeholder="Vor- und Nachname"
                  value={participantName}
                />
              </label>
              <label>
                ID <span className="required">*</span>
                <input
                  autoComplete="off"
                  disabled={isActive}
                  maxLength={80}
                  onChange={(event) => setParticipantId(event.target.value)}
                  placeholder="Teilnehmer-ID"
                  value={participantId}
                />
              </label>
            </div>
            <p className="field-hint">Beide Angaben sind erforderlich und werden mit jedem Durchgang gespeichert.</p>
          </section>

          <section className="panel test-panel" aria-labelledby="test-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">TESTART</p>
                <h3 id="test-title">Reiz auswählen</h3>
              </div>
              <span className="step-indicator">02</span>
            </div>
            <div className="test-options">
              <button
                aria-pressed={testType === 'visual'}
                className={`test-option ${testType === 'visual' ? 'selected' : ''}`}
                disabled={isActive}
                onClick={() => setTestType('visual')}
                type="button"
              >
                <span className="option-icon visual-icon" aria-hidden="true">◉</span>
                <span><strong>Visuell</strong><small>Auf ein grünes Signal reagieren</small></span>
                <span className="radio-dot" />
              </button>
              <button
                aria-pressed={testType === 'audio'}
                className={`test-option ${testType === 'audio' ? 'selected' : ''}`}
                disabled={isActive}
                onClick={() => setTestType('audio')}
                type="button"
              >
                <span className="option-icon audio-icon" aria-hidden="true">♫</span>
                <span><strong>Akustisch</strong><small>Auf einen kurzen Ton reagieren</small></span>
                <span className="radio-dot" />
              </button>
            </div>

            <div className={`reaction-stage ${cueActive ? 'stage-cue' : ''}`}>
              {phase === 'idle' && <span className="stage-copy">Starte den Durchgang, wenn du bereit bist.</span>}
              {phase === 'waiting' && <span className="stage-copy"><span className="pulse-dot" /> Warte auf das Signal …</span>}
              {phase === 'signal' && testType === 'visual' && <span className="stage-cue-text">JETZT!</span>}
              {phase === 'signal' && testType === 'audio' && <span className="stage-copy"><span className="sound-rings">)))</span> Jetzt reagieren</span>}
              {phase === 'saving' && <span className="stage-copy">Ergebnis wird gespeichert …</span>}
              {phase === 'done' && <span className="stage-copy success-copy">Durchgang gespeichert.</span>}
              {phase === 'save-error' && <span className="stage-copy error-copy">Ergebnis noch nicht gespeichert.</span>}
            </div>

            <div className="action-row">
              {phase === 'idle' || phase === 'done' ? (
                <button className="primary-button" onClick={startTest} type="button">
                  <span aria-hidden="true">▶</span> Durchgang starten
                </button>
              ) : null}
              {phase === 'waiting' ? (
                <button className="secondary-button" onClick={cancelTest} type="button">Abbrechen</button>
              ) : null}
              {phase === 'signal' ? (
                <button className="response-button" onClick={saveResponse} type="button">Jetzt reagieren · Leertaste</button>
              ) : null}
              {phase === 'save-error' ? (
                <button className="primary-button" onClick={retrySave} type="button">Speichern erneut versuchen</button>
              ) : null}
              {latestResult && phase === 'done' ? (
                <div className="result-chip"><span>Reaktionszeit</span><strong>{formatMs(latestResult.reactionTimeMs)}</strong></div>
              ) : null}
            </div>
            {error && <p className="notice error-notice" role="alert">{error}</p>}
            {!isAudioReady && <p className="notice">Bitte prüfe, ob ein Audioausgabegerät angeschlossen und aktiviert ist.</p>}
          </section>

          <section className="panel stats-panel" aria-labelledby="stats-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">BISHERIGE DURCHGÄNGE</p>
                <h3 id="stats-title">Statistik für die ID</h3>
              </div>
              <span className="record-count">{currentRecords.length} gespeichert</span>
            </div>
            {!participantId.trim() ? (
              <p className="empty-state">Gib eine ID ein, um die gespeicherten Ergebnisse dieser Person zu sehen.</p>
            ) : (
              <div className="stats-grid">
                {Object.entries(testLabels).map(([key, label]) => {
                  const stat = statistics[key];
                  return (
                    <div className="stat-card" key={key}>
                      <div className="stat-card-title"><span className={`mini-indicator ${key}`} />{label}</div>
                      <div className="stat-line"><span>Anzahl</span><strong>{stat.count}</strong></div>
                      <div className="stat-line"><span>Durchschnitt</span><strong>{stat.mean === null ? '—' : formatMs(stat.mean)}</strong></div>
                      <div className="stat-line"><span>Median</span><strong>{stat.median === null ? '—' : formatMs(stat.median)}</strong></div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </section>

        <aside className="side-column">
          <section className="panel device-panel" aria-labelledby="device-title">
            <div className="panel-heading compact-heading">
              <div>
                <p className="eyebrow">SYSTEMINFORMATION</p>
                <h3 id="device-title">Dieses Gerät</h3>
              </div>
              <span className="device-icon" aria-hidden="true">▣</span>
            </div>
            {device ? (
              <dl className="device-list">
                <div><dt>Betriebssystem</dt><dd>{device.operatingSystem}</dd></div>
                <div><dt>Prozessor</dt><dd>{device.cpuModel}</dd></div>
                <div><dt>Gemeldeter CPU-Takt</dt><dd>{device.cpuSpeedMhz ? `${device.cpuSpeedMhz} MHz` : 'Nicht verfügbar'}</dd></div>
                <div><dt>Logische Kerne</dt><dd>{device.logicalCores}</dd></div>
                <div><dt>Arbeitsspeicher</dt><dd>{device.memoryGb} GB</dd></div>
                <div><dt>Bildschirm</dt><dd>{device.displayWidth} × {device.displayHeight}</dd></div>
                <div><dt>Bildschirmfrequenz</dt><dd>{device.displayRefreshRateHz ? `${device.displayRefreshRateHz} Hz` : 'Nicht verfügbar'}</dd></div>
                <div><dt>Nominales Bildintervall</dt><dd>{device.nominalFrameIntervalMs ? `${device.nominalFrameIntervalMs} ms` : 'Nicht verfügbar'}</dd></div>
                <div><dt>Audioverzögerung</dt><dd>{device.audioLatency}</dd></div>
              </dl>
            ) : <p className="empty-state">Geräteinformationen werden geladen …</p>}
            <div className="timing-note">
              <span className="info-icon">i</span>
              <p>Die Gerätewerte helfen, den Test einzuordnen. Sie sind keine externe Kalibrierung und werden nicht von der gemessenen Reaktionszeit abgezogen.</p>
            </div>
          </section>

          <section className="panel storage-panel" aria-labelledby="storage-title">
            <p className="eyebrow">DATENSPEICHERUNG</p>
            <h3 id="storage-title">Deine Ergebnisse</h3>
            <p>Jeder gespeicherte Durchgang kommt als eigene Zeile in die lokale Excel-Datei.</p>
            <div className="path-box">{filePath || 'Dokumente / Reaktionszeit-App / Ergebnisse.xlsx'}</div>
            <button className="text-button" onClick={refreshRecords} type="button">Ergebnisse neu laden ↻</button>
          </section>
        </aside>
      </div>
      <footer className="footer-note">Erste Projektversion · Zeitwerte sind nicht extern kalibriert</footer>
    </main>
  );
}

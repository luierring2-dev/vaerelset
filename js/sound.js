const BEEP_EVERY_MS = 1000;
const BEEP_LENGTH_S = 0.4;

// iOS kræver, at lyd er låst op af et tryk. Derfor låses den op ved første tryk
// på skærmen, så den kan bruges senere om natten. Det er ikke garanteret at virke.
export function createAlarmSound(win = window) {
  let context = null;
  let timer = null;

  function unlock() {
    const AudioContext = win.AudioContext ?? win.webkitAudioContext;
    if (!AudioContext) return;
    context ??= new AudioContext();
    context.resume?.().catch(() => {});
  }

  win.addEventListener('pointerdown', unlock, { capture: true });

  function beep() {
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.6;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + BEEP_LENGTH_S);
  }

  return {
    start() {
      if (timer) return;
      context?.resume?.().catch(() => {});
      beep();
      timer = setInterval(beep, BEEP_EVERY_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

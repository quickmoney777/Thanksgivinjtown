// Sound effects for the TV, made with the Web Audio API so there are no
// sound files to manage. Browsers only allow sound after a click, which is
// why the host screen starts with an "Open the room" button.
window.Sfx = (() => {
  let ctx = null;
  let silent = false;

  function unlock() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, startIn, length, type = 'triangle', volume = 0.16) {
    if (!ctx || ctx.state !== 'running' || silent) return;
    const at = ctx.currentTime + startIn;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  return {
    unlock,
    mute(on) {
      silent = Boolean(on);
    },
    join() {
      tone(523, 0, 0.12);
      tone(784, 0.1, 0.2);
    },
    leave() {
      tone(392, 0, 0.12);
      tone(294, 0.1, 0.2);
    },
    start() {
      [392, 523, 659, 784].forEach((f, i) => tone(f, i * 0.12, 0.2, 'square', 0.07));
      tone(1047, 0.48, 0.5, 'square', 0.07);
    },
    round() {
      [330, 440, 554, 659].forEach((f, i) => tone(f, i * 0.09, 0.22, 'triangle', 0.14));
    },
    question() {
      tone(660, 0, 0.1);
      tone(880, 0.08, 0.16);
    },
    lockIn() {
      tone(988, 0, 0.09, 'sine', 0.14);
    },
    miss() {
      tone(330, 0, 0.08, 'triangle', 0.1);
      tone(262, 0.07, 0.12, 'triangle', 0.1);
    },
    tick() {
      tone(1200, 0, 0.05, 'square', 0.05);
    },
    timeUp() {
      tone(220, 0, 0.35, 'sawtooth', 0.09);
      tone(165, 0.12, 0.45, 'sawtooth', 0.09);
    },
    allIn() {
      tone(784, 0, 0.1);
      tone(988, 0.09, 0.1);
      tone(1175, 0.18, 0.2);
    },
    reveal() {
      [523, 659, 784].forEach((f) => tone(f, 0, 0.6, 'triangle', 0.11));
      tone(1047, 0.12, 0.6, 'triangle', 0.11);
    },
    scores() {
      [523, 587, 659, 784, 880].forEach((f, i) => tone(f, i * 0.07, 0.18, 'triangle', 0.12));
    },
    final() {
      const notes = [523, 523, 523, 659, 784, 659, 784, 1047];
      const at = [0, 0.15, 0.3, 0.45, 0.7, 0.95, 1.1, 1.3];
      notes.forEach((f, i) => tone(f, at[i], i === notes.length - 1 ? 0.9 : 0.22, 'square', 0.07));
    },
  };
})();

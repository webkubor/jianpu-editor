/**
 * 离线音频渲染与 WAV 编码器：使用 OfflineAudioContext 将乐谱事件流直接渲染为高质量 WAV 音频文件
 */
import type { PlayEvent } from "./player.ts";

/** 将 AudioBuffer 编码为标准 16-bit PCM WAV 二进制格式 */
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const channelData = buffer.getChannelData(0);
  const numSamples = channelData.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF Chunk
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");

  // fmt Chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data Chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM Samples (Float32 -> Int16)
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Uint8Array(arrayBuffer);
}

/** 使用 OfflineAudioContext 离线加速渲染整首乐谱为 WAV 二进制流 */
export async function renderScoreToWav(events: PlayEvent[]): Promise<Uint8Array> {
  if (events.length === 0) throw new Error("乐谱为空，无可导出的音频事件");
  const sampleRate = 44100;
  const totalDuration = events[events.length - 1].start + events[events.length - 1].duration + 0.3;
  const lengthInFrames = Math.ceil(totalDuration * sampleRate);

  const ctx = new OfflineAudioContext(1, lengthInFrames, sampleRate);
  const t0 = 0.05;

  for (const ev of events) {
    if (ev.midi === null) continue;
    const at = t0 + ev.start;
    const freq = 440 * 2 ** ((ev.midi - 69) / 12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.14, at + 0.02);
    gain.gain.setValueAtTime(0.14, at + ev.duration * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, at + ev.duration);
    gain.connect(ctx.destination);

    for (const [mult, vol] of [[1, 1], [2, 0.3], [3, 0.12]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      const og = ctx.createGain();
      og.gain.value = vol;
      osc.connect(og).connect(gain);
      osc.start(at);
      osc.stop(at + ev.duration + 0.02);
    }
  }

  const renderedBuffer = await ctx.startRendering();
  return audioBufferToWav(renderedBuffer);
}

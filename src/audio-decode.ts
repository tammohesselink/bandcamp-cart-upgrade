// Decodes audio file bytes in the page, for tempo analysis and the waveform.

// Decodes to one array of samples per channel at `sampleRate`. An offline
// context decodes straight to that rate and, unlike an AudioContext, holds no
// audio device that would need closing. `bytes` must own its whole buffer
// (base64ToBytes gives one that does), so no copy is needed.
export async function decodeAudioChannels(bytes: Uint8Array, sampleRate: number): Promise<Float32Array[]> {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = await context.decodeAudioData(bytes.buffer as ArrayBuffer);
  return Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
}

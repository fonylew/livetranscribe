/**
 * 16 kHz mono AudioWorkletProcessor (adapted from Interpretab).
 * Emits 128-sample Float32Array frames (~8 ms each at 16 kHz) to the main thread.
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    if (inputs.length > 0 && inputs[0].length > 0) {
      const inputChannel = inputs[0][0];
      const inputCopy = new Float32Array(inputChannel);
      this.port.postMessage(inputCopy);
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PCMRecorderProcessor);

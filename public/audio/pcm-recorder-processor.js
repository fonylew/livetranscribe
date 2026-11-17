/**
 * 16 kHz mono AudioWorkletProcessor.
 * Coalesces four 128-sample render quanta into 512-sample frames (~32 ms at 16 kHz)
 * so the main thread receives ~31 messages/sec instead of 125 messages/sec.
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(512);
    this._offset = 0;
  }

  process(inputs) {
    if (inputs.length > 0 && inputs[0].length > 0) {
      const inputChannel = inputs[0][0];
      if (inputChannel && inputChannel.length > 0) {
        if (this._offset + inputChannel.length > this._buffer.length) {
          this.port.postMessage(this._buffer.slice(0, this._offset));
          this._offset = 0;
        }
        this._buffer.set(inputChannel, this._offset);
        this._offset += inputChannel.length;
        if (this._offset >= this._buffer.length) {
          this.port.postMessage(this._buffer.slice(0, this._offset));
          this._offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PCMRecorderProcessor);

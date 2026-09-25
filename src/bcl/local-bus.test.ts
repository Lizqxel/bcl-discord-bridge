import { describe, expect, it } from 'vitest';
import { BYTES_PER_FRAME } from '../audio/constants.js';
import { PcmMixer } from '../audio/mixer.js';
import { LocalAudioBus } from './local-bus.js';

describe('LocalAudioBus', () => {
  it('delivers a speaker frame to every other bridged listener but not back to the speaker', () => {
    const bus = new LocalAudioBus();
    const a = new PcmMixer();
    const b = new PcmMixer();
    const c = new PcmMixer();
    bus.register('a', a);
    bus.register('b', b);
    bus.register('c', c);

    bus.publish('a', Buffer.alloc(BYTES_PER_FRAME, 1));

    const source = LocalAudioBus.sourceId('a');
    expect(a.getSource(source)).toBeUndefined();
    expect(b.getSource(source)?.queuedFrames).toBe(1);
    expect(c.getSource(source)?.queuedFrames).toBe(1);
  });

  it('identifies bridged peers by socket id or in-game client id', () => {
    const bus = new LocalAudioBus();
    bus.register('a', new PcmMixer());
    bus.setSocketId('a', 'socket-a');
    bus.setClientId('a', 7);

    expect(bus.isLocal('socket-a')).toBe(true);
    expect(bus.isLocal('other', 7)).toBe(true);
    expect(bus.isLocal('desktop-host', 1)).toBe(false);
  });

  it('lists only speakers that have been matched to an in-game player', () => {
    const bus = new LocalAudioBus();
    bus.register('a', new PcmMixer());
    bus.register('b', new PcmMixer());
    bus.register('c', new PcmMixer());
    bus.setClientId('b', 2);

    expect(bus.speakersFor('a')).toEqual([{ sourceId: LocalAudioBus.sourceId('b'), clientId: 2 }]);
  });

  it('removes a departed speaker from remaining mixers', () => {
    const bus = new LocalAudioBus();
    const listener = new PcmMixer();
    bus.register('listener', listener);
    bus.register('gone', new PcmMixer());
    bus.publish('gone', Buffer.alloc(BYTES_PER_FRAME));
    bus.unregister('gone');

    expect(listener.getSource(LocalAudioBus.sourceId('gone'))).toBeUndefined();
  });
});

describe('LocalAudioBus claims', () => {
  it('reports a clientId followed by another session, but not by the asker', () => {
    const bus = new LocalAudioBus();
    bus.register('a', new PcmMixer());
    bus.register('b', new PcmMixer());
    bus.setClientId('b', 42);
    expect(bus.isClaimedByOther('a', 42)).toBe(true);
    expect(bus.isClaimedByOther('b', 42)).toBe(false);
  });

  it('can include speakers that are not placed in game yet', () => {
    const bus = new LocalAudioBus();
    bus.register('a', new PcmMixer());
    bus.register('b', new PcmMixer());
    expect(bus.speakersFor('a')).toEqual([]);
    expect(bus.speakersFor('a', true)).toEqual([{ sourceId: LocalAudioBus.sourceId('b'), clientId: undefined }]);
  });
});

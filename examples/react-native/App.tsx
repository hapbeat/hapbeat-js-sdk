/**
 * Hapbeat React Native demo (Android-first).
 *
 * Button taps broadcast UDP straight from the phone over Wi-Fi — no
 * hapbeat-helper. Drop this into a bare React Native app; see README.md for the
 * full setup (install @hapbeat/sdk + react-native-udp, polyfill, run).
 */

// --- TextEncoder/TextDecoder polyfill (REQUIRED) ---------------------------
// The wire protocol uses TextEncoder/TextDecoder. RN's Hermes (incl. 0.86)
// ships TextEncoder but NOT TextDecoder, so a polyfill is required. It must run
// before @hapbeat/sdk loads, so keep it as the very first import (`npm i
// fast-text-encoding`). Verified on Android with RN 0.86.
import 'fast-text-encoding';

import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Pressable,
  View,
} from 'react-native';

import { connect } from '@hapbeat/sdk';
import type { Hapbeat } from '@hapbeat/sdk';

// Contracts-canonical connectivity-test event (deploy the sample-kit in Studio).
const SAMPLE_EVENT = 'sample-kit.sine_100hz';

/** Synthesize a mono 16 kHz PCM16 sine buffer for the streaming test. */
function sinePcm16(freqHz: number, durSec: number, amp = 0.8, sampleRate = 16000): Uint8Array {
  const n = Math.floor(durSec * sampleRate);
  const out = new Uint8Array(n * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
    dv.setInt16(i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }
  return out;
}

export default function App(): React.JSX.Element {
  const hbRef = useRef<Hapbeat | null>(null);
  const [status, setStatus] = useState('connecting…');
  const [devices, setDevices] = useState<number | null>(null);
  const [eventId, setEventId] = useState(SAMPLE_EVENT);
  const [target, setTarget] = useState(''); // "" = broadcast to all

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const hb = await connect({ appName: 'RN Demo' }); // ASCII appName (see README for JA)
        if (!alive) {
          await hb.close();
          return;
        }
        hbRef.current = hb;
        setStatus('connected — broadcasting over Wi-Fi (no helper)');
        const found = await hb.discover(1500);
        if (alive) setDevices(found.length);
      } catch (e) {
        setStatus('connect failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    })();
    return () => {
      alive = false;
      hbRef.current?.close();
      hbRef.current = null;
    };
  }, []);

  const rediscover = async (): Promise<void> => {
    const hb = hbRef.current;
    if (!hb) return;
    setStatus('scanning…');
    const found = await hb.discover(1500);
    setDevices(found.length);
    setStatus(`found ${found.length} device(s)`);
  };

  const fire = (): void => {
    hbRef.current?.play(eventId, { gain: 0.8, target });
    setStatus(`play → ${eventId}`);
  };

  const stop = (): void => {
    hbRef.current?.stopAll(target);
    setStatus('stopAll');
  };

  const stream = (): void => {
    hbRef.current?.streamPcm(sinePcm16(100, 1.0), {
      sampleRate: 16000,
      channels: 1,
      gain: 0.9,
      target,
    });
    setStatus('stream 1 s @100 Hz');
  };

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Hapbeat RN demo</Text>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.sub}>
          devices found: {devices === null ? '—' : devices}
        </Text>

        <Text style={styles.label}>Event ID</Text>
        <TextInput
          style={styles.input}
          value={eventId}
          onChangeText={setEventId}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>Target (empty = broadcast)</Text>
        <TextInput
          style={styles.input}
          value={target}
          onChangeText={setTarget}
          placeholder="player_1/chest  /  */chest  /  (empty)"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Button label="▶ Fire (command)" onPress={fire} />
        <Button label="■ Stop" onPress={stop} kind="muted" />
        <Button label="〜 Stream 1 s (100 Hz)" onPress={stream} />
        <Button label="⟳ Rediscover" onPress={rediscover} kind="muted" />

        <Text style={styles.hint}>
          The phone and a Hapbeat must be on the same Wi-Fi. Deploy the sample-kit
          in Hapbeat Studio so the event has sound.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Button(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'muted';
}): React.JSX.Element {
  const muted = props.kind === 'muted';
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.btn,
        muted && styles.btnMuted,
        pressed && styles.btnPressed,
      ]}
    >
      <Text style={[styles.btnText, muted && styles.btnTextMuted]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f1115' },
  content: { padding: 20, gap: 10 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  status: { color: '#7ee0c0', fontSize: 14 },
  sub: { color: '#9aa3b2', fontSize: 13, marginBottom: 8 },
  label: { color: '#9aa3b2', fontSize: 12, marginTop: 8 },
  input: {
    backgroundColor: '#1a1e26',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  btn: {
    backgroundColor: '#5b6cff',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  btnMuted: { backgroundColor: '#222936' },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  btnTextMuted: { color: '#c5ccd9' },
  hint: { color: '#6b7280', fontSize: 12, marginTop: 18, lineHeight: 18 },
});

/**
 * Deterministic FAST guidance.
 *
 * DESIGN RULE: emergency instructions never depend on a network call. The LLM
 * triage layer enriches this text with the specific metrics, but if OpenRouter
 * is slow, rate-limited, or unreachable, the patient and family still get
 * complete first-response steps immediately. The LLM is an enhancement on top
 * of this, never a prerequisite for it.
 */

export const EMERGENCY_NUMBER = "119";
export const EMERGENCY_NUMBER_ALT = "112";

export interface FastStep {
  letter: string;
  title: string;
  body: string;
}

export const FAST_STEPS: FastStep[] = [
  {
    letter: "F",
    title: "Face - Wajah",
    body:
      "Minta orang tersebut tersenyum. Perhatikan apakah satu sisi wajah turun, " +
      "mulut mencong, atau kelopak mata tidak simetris.",
  },
  {
    letter: "A",
    title: "Arms - Lengan",
    body:
      "Minta angkat kedua lengan selama 10 detik. Waspadai bila satu lengan " +
      "melemah, turun sendiri, atau tidak bisa diangkat.",
  },
  {
    letter: "S",
    title: "Speech - Bicara",
    body:
      "Minta mengulang satu kalimat sederhana. Waspadai bicara pelo, kacau, " +
      "atau tidak dapat berbicara sama sekali.",
  },
  {
    letter: "T",
    title: "Time - Waktu",
    body:
      `Jika salah satu tanda muncul, segera hubungi ${EMERGENCY_NUMBER} atau ` +
      `${EMERGENCY_NUMBER_ALT}. Catat jam pertama kali gejala terlihat - ` +
      "informasi ini menentukan pilihan terapi di rumah sakit.",
  },
];

export const IMMEDIATE_ACTIONS: string[] = [
  `Hubungi ${EMERGENCY_NUMBER} (ambulans) atau ${EMERGENCY_NUMBER_ALT} sekarang. Jangan menyetir sendiri ke rumah sakit.`,
  "Catat waktu pasti gejala pertama kali muncul dan sampaikan ke petugas medis.",
  "Baringkan pasien dengan kepala dan bahu sedikit terangkat (sekitar 30 derajat).",
  "Jangan berikan makanan, minuman, atau obat apa pun melalui mulut - risiko tersedak tinggi.",
  "Longgarkan pakaian yang ketat dan pastikan jalan napas bebas.",
  "Tetap dampingi pasien dan pantau kesadaran serta napas sampai bantuan tiba.",
];

/** Plain-text version, used as the triage fallback when the LLM is unavailable. */
export function fastProtocolText(): string {
  const steps = FAST_STEPS.map((s) => `${s.letter} - ${s.title}: ${s.body}`).join("\n");
  const actions = IMMEDIATE_ACTIONS.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `PROTOKOL FAST\n${steps}\n\nTINDAKAN SEGERA\n${actions}`;
}

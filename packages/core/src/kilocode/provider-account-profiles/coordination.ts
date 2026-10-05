// kilocode_change - opt-in gate for Kilo provider profiles
export function enabled() {
  return process.env.KILO_EXPERIMENTAL_PROVIDER_PROFILES === "1"
}

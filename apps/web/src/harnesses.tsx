/**
 * Harness registry for the web UI. Adding an agent means: an adapter in
 * `@harness-trajectory/core`, a transcript root in the server, and one entry here.
 */

import { useId, type CSSProperties } from 'react'
import { HARNESS_KINDS, type HarnessKind } from '@harness-trajectory/core'

export interface HarnessLogoProps {
  /** Square edge in px. */
  size?: number
  className?: string | undefined
  style?: CSSProperties | undefined
}

export type HarnessLogo = (props: HarnessLogoProps) => JSX.Element

export interface HarnessMeta {
  kind: HarnessKind
  /** Full name shown in menus and headers. */
  label: string
  /** Two-letter monogram for tight cells. */
  short: string
  /** Brand accent used for the mark and badges (any CSS color). */
  accent: string
  /** Brand mark, drawn in `currentColor` on a 24x24 grid. */
  Logo: HarnessLogo
  /** Shell command that reopens the session in the harness CLI. */
  resumeCommand: (session: ResumeTarget) => string
}

export interface ResumeTarget {
  id: string
  cwd: string | null
}

/** Quote a path for a POSIX shell unless it is plain enough to pass through. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

/** `cd` into the session's working directory, then run the resume command there. */
function inWorkingDirectory(session: ResumeTarget, command: string): string {
  return session.cwd === null || session.cwd === '' ? command : `cd ${shellQuote(session.cwd)} && ${command}`
}

/**
 * Brand marks. The Claude sunburst path is from Simple Icons (CC0 1.0); the
 * Codex, Kimi and Grok paths are from lobe-icons (`@lobehub/icons-static-svg`,
 * MIT, (c) LobeHub). The marks themselves belong to Anthropic, OpenAI,
 * Moonshot AI, and xAI and identify their harnesses here. The Devin and pi
 * marks are in-house monograms (neither icon set ships them). The OpenCode
 * mark is an in-house monogram too — a terminal-prompt chevron over an
 * underscore, not the project's own logo. The dsh mark is DeepSeek's fish
 * logo (`FISH_LOGO_PATH`, deepseek-harness's ui-primitives FishLogo).
 */
const CLAUDE_PATH ='m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'

const CODEX_PATH = 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'

/**
 * Kimi mark: two subpaths (the dot and the "k" stroke), 24x24 viewBox,
 * evenodd fill, straight from lobe-icons.
 */
const KIMI_PATH =
  'M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z ' +
  'M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z'

/**
 * Grok mark: one evenodd subpath (the slashed orbit), 24x24 viewBox, straight
 * from lobe-icons.
 */
const GROK_PATH =
  'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815'

/** Claude mark (the sunburst), drawn in `currentColor`. */
export function ClaudeLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden="true">
      <path d={CLAUDE_PATH} />
    </svg>
  )
}

/** Codex mark (the blossom with a prompt), filled with the brand gradient. */
export function CodexLogo({ size = 16, className, style }: HarnessLogoProps) {
  const gradientId = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fillRule="evenodd" className={className} style={style} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">
          <stop stopColor="#B1A7FF" />
          <stop offset="0.5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
      <path clipRule="evenodd" d={CODEX_PATH} fill={`url(#${gradientId})`} />
    </svg>
  )
}

/** Kimi mark (the dot and the "k" stroke), drawn in `currentColor`. */
export function KimiLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} style={style} aria-hidden="true">
      <path d={KIMI_PATH} />
    </svg>
  )
}

/** Grok mark (the slashed orbit), drawn in `currentColor`. */
export function GrokLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} style={style} aria-hidden="true">
      <path d={GROK_PATH} />
    </svg>
  )
}

/** Devin mark: an in-house monogram — a "D" of nested chevrons, drawn in `currentColor`. */
export function DevinLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style} aria-hidden="true">
      <path d="M6 4h5.5a8 8 0 010 16H6V4zm4.2 3.6H9.4v8.8h.8a4.4 4.4 0 000-8.8z" fill="currentColor" />
      <path d="M16.6 8.4 21 12l-4.4 3.6v-2.2l2-1.4-2-1.4V8.4z" fill="currentColor" opacity=".55" />
    </svg>
  )
}

/** pi mark: an in-house monogram — a "π" glyph, drawn in `currentColor`. */
export function PiLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style} aria-hidden="true">
      <path d="M4 6h16v2.6H4z" fill="currentColor" />
      <path d="M8.6 8.6v9c0 1-.8 1.9-1.9 1.9H4.5v-2.6h1.7V8.6h2.4z" fill="currentColor" />
      <path d="M15.4 8.6c0 3.6-1.1 7.2-2.7 10.9h3c1.2-2.9 1.9-6.5 1.9-10.9h-2.2z" fill="currentColor" />
    </svg>
  )
}

/** OpenCode mark: an in-house monogram — a prompt chevron over an underscore, drawn in `currentColor`. */
export function OpencodeLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style} aria-hidden="true">
      <path d="M4 5.5 11.5 12 4 18.5v-3.3L8 12 4 8.8V5.5z" fill="currentColor" />
      <path d="M13 16.5h7V19h-7v-2.5z" fill="currentColor" opacity=".7" />
    </svg>
  )
}

/**
 * dsh mark: DeepSeek's fish logo (deepseek-harness's `FISH_LOGO_PATH`,
 * ui-primitives FishLogo), drawn in `currentColor`. Native grid is 23.16×17.04;
 * the square viewport centers it vertically via the default aspect rule.
 */
const DSH_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

export function DshLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 23.16 17.04" fill="none" className={className} style={style} aria-hidden="true">
      <path d={DSH_PATH} fill="currentColor" />
    </svg>
  )
}

/** Neutral fallback for kinds without a registered mark. */
export function GenericHarnessLogo({ size = 16, className, style }: HarnessLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  )
}

export const HARNESSES: readonly HarnessMeta[] = [
  {
    kind: 'claude',
    label: 'Claude Code',
    short: 'CC',
    accent: '#D97757',
    Logo: ClaudeLogo,
    // Claude Code looks sessions up under the project of the current directory.
    resumeCommand: session => inWorkingDirectory(session, `claude --resume ${shellQuote(session.id)}`),
  },
  {
    kind: 'codex',
    label: 'Codex',
    short: 'CX',
    accent: '#5B7CFF',
    Logo: CodexLogo,
    resumeCommand: session => inWorkingDirectory(session, `codex resume ${shellQuote(session.id)}`),
  },
  {
    kind: 'kimi',
    label: 'Kimi Code',
    short: 'KM',
    // Kimi's mark is black; use the theme-aware label color so it stays visible in dark mode.
    accent: 'var(--dsw-alias-label-primary)',
    Logo: KimiLogo,
    resumeCommand: session => inWorkingDirectory(session, `kimi --session ${shellQuote(session.id)}`),
  },
  {
    kind: 'grok',
    label: 'Grok Build',
    short: 'GK',
    // The Grok mark is monochrome black; use the theme-aware label color so it
    // stays visible in dark mode, exactly as the Kimi entry does.
    accent: 'var(--dsw-alias-label-primary)',
    Logo: GrokLogo,
    resumeCommand: session => inWorkingDirectory(session, `grok --resume ${shellQuote(session.id)}`),
  },
  {
    kind: 'devin',
    label: 'Devin CLI',
    short: 'DV',
    accent: '#6E56CF',
    Logo: DevinLogo,
    // Devin CLI scopes sessions to the working directory they ran in.
    resumeCommand: session => inWorkingDirectory(session, `devin -r ${shellQuote(session.id)}`),
  },
  {
    kind: 'pi',
    label: 'Pi',
    short: 'PI',
    accent: '#1F9D8A',
    Logo: PiLogo,
    resumeCommand: session => inWorkingDirectory(session, `pi --session ${shellQuote(session.id)}`),
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    short: 'OC',
    // The mark is monochrome; use the theme-aware label color so it stays
    // visible in dark mode, exactly as the Kimi/Grok entries do.
    accent: 'var(--dsw-alias-label-primary)',
    Logo: OpencodeLogo,
    resumeCommand: session => inWorkingDirectory(session, `opencode --session ${shellQuote(session.id)}`),
  },
  {
    kind: 'dsh',
    label: 'DSH',
    short: 'DS',
    accent: '#4D6BFE',
    Logo: DshLogo,
    // `--resume` belongs to the tui profile, not the launcher.
    resumeCommand: session => inWorkingDirectory(session, `dsh tui --resume ${shellQuote(session.id)}`),
  },
]

const BY_KIND = new Map(HARNESSES.map(meta => [meta.kind, meta]))

/** Registry entry for a kind; unknown kinds get a neutral fallback so new adapters never crash the UI. */
export function harnessMeta(kind: HarnessKind): HarnessMeta {
  return BY_KIND.get(kind) ?? {
    kind,
    label: kind,
    short: kind.slice(0, 2).toUpperCase(),
    accent: 'var(--dsw-alias-label-tertiary)',
    Logo: GenericHarnessLogo,
    resumeCommand: session => session.id,
  }
}

/** Every kind the core knows, in registry order first, then any registry-less kinds. */
export function allHarnessKinds(): readonly HarnessKind[] {
  const known = HARNESSES.map(meta => meta.kind)
  return [...known, ...HARNESS_KINDS.filter(kind => !known.includes(kind))]
}

/** The mark for a kind, tinted with its accent. */
export function HarnessMark({ kind, size = 16, className }: { kind: HarnessKind; size?: number; className?: string | undefined }) {
  const meta = harnessMeta(kind)
  return <meta.Logo size={size} className={className} style={{ color: meta.accent }} />
}

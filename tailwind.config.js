/**
 * Compiled by `npm run build:css` into apps/web/public/tailwind.css.
 *
 * Replaces the cdn.tailwindcss.com script the pages used to load, which shipped
 * ~400KB of JavaScript to every visitor, ran the compiler in their browser on
 * every page load, and made a third party's uptime a dependency of the
 * dashboard rendering at all.
 *
 * IMPORTANT: the scanner reads source text, so every class has to appear whole
 * in one of the files below. `text-${accent}` compiles to nothing — pass
 * complete class names ('text-primary'), never bare colour tokens ('primary').
 * The CDN build hid this class of mistake because it watched the live DOM
 * instead of the source.
 */

import forms from '@tailwindcss/forms'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./apps/web/public/**/*.{html,js}'],
  darkMode: 'class',
  theme: {
    extend: {
      /*
       * Token names only. The values live in apps/web/styles/app.css as bare
       * RGB channels, which is what lets one name resolve to purple for Bonus
       * Hunt and indigo for tournaments, and what keeps `/20` opacity
       * modifiers working.
       */
      colors: {
        'primary': 'rgb(var(--primary) / <alpha-value>)',
        'primary-container': 'rgb(var(--primary-container) / <alpha-value>)',
        'primary-fixed': 'rgb(var(--primary-fixed) / <alpha-value>)',
        'primary-fixed-dim': 'rgb(var(--primary-fixed-dim) / <alpha-value>)',
        'inverse-primary': 'rgb(var(--inverse-primary) / <alpha-value>)',
        'on-primary': 'rgb(var(--on-primary) / <alpha-value>)',
        'on-primary-container': 'rgb(var(--on-primary-container) / <alpha-value>)',
        'on-primary-fixed': 'rgb(var(--on-primary-fixed) / <alpha-value>)',
        'on-primary-fixed-variant': 'rgb(var(--on-primary-fixed-variant) / <alpha-value>)',
        'secondary': 'rgb(var(--secondary) / <alpha-value>)',
        'secondary-container': 'rgb(var(--secondary-container) / <alpha-value>)',
        'secondary-fixed': 'rgb(var(--secondary-fixed) / <alpha-value>)',
        'secondary-fixed-dim': 'rgb(var(--secondary-fixed-dim) / <alpha-value>)',
        'on-secondary': 'rgb(var(--on-secondary) / <alpha-value>)',
        'on-secondary-container': 'rgb(var(--on-secondary-container) / <alpha-value>)',
        'on-secondary-fixed': 'rgb(var(--on-secondary-fixed) / <alpha-value>)',
        'on-secondary-fixed-variant': 'rgb(var(--on-secondary-fixed-variant) / <alpha-value>)',
        'tertiary': 'rgb(var(--tertiary) / <alpha-value>)',
        'tertiary-container': 'rgb(var(--tertiary-container) / <alpha-value>)',
        'tertiary-fixed': 'rgb(var(--tertiary-fixed) / <alpha-value>)',
        'tertiary-fixed-dim': 'rgb(var(--tertiary-fixed-dim) / <alpha-value>)',
        'on-tertiary': 'rgb(var(--on-tertiary) / <alpha-value>)',
        'on-tertiary-container': 'rgb(var(--on-tertiary-container) / <alpha-value>)',
        'on-tertiary-fixed': 'rgb(var(--on-tertiary-fixed) / <alpha-value>)',
        'on-tertiary-fixed-variant': 'rgb(var(--on-tertiary-fixed-variant) / <alpha-value>)',
        'background': 'rgb(var(--background) / <alpha-value>)',
        'surface-container-lowest': 'rgb(var(--surface-container-lowest) / <alpha-value>)',
        'surface-container-low': 'rgb(var(--surface-container-low) / <alpha-value>)',
        'surface-container': 'rgb(var(--surface-container) / <alpha-value>)',
        'surface-container-high': 'rgb(var(--surface-container-high) / <alpha-value>)',
        'surface-container-highest': 'rgb(var(--surface-container-highest) / <alpha-value>)',
        'surface-bright': 'rgb(var(--surface-bright) / <alpha-value>)',
        'on-surface': 'rgb(var(--on-surface) / <alpha-value>)',
        'on-surface-variant': 'rgb(var(--on-surface-variant) / <alpha-value>)',
        'outline': 'rgb(var(--outline) / <alpha-value>)',
        'outline-variant': 'rgb(var(--outline-variant) / <alpha-value>)',
        'win': 'rgb(var(--win) / <alpha-value>)',
        'loss': 'rgb(var(--loss) / <alpha-value>)',
        'gold': 'rgb(var(--gold) / <alpha-value>)',
        'error': 'rgb(var(--error) / <alpha-value>)',
        'error-container': 'rgb(var(--error-container) / <alpha-value>)',
        'on-error': 'rgb(var(--on-error) / <alpha-value>)',
        'on-error-container': 'rgb(var(--on-error-container) / <alpha-value>)',
        'surface': 'rgb(var(--surface) / <alpha-value>)',
        'surface-dim': 'rgb(var(--surface-dim) / <alpha-value>)',
        'surface-variant': 'rgb(var(--surface-variant) / <alpha-value>)',
        'surface-tint': 'rgb(var(--surface-tint) / <alpha-value>)',
        'on-background': 'rgb(var(--on-background) / <alpha-value>)',
        'inverse-surface': 'rgb(var(--inverse-surface) / <alpha-value>)',
        'inverse-on-surface': 'rgb(var(--inverse-on-surface) / <alpha-value>)',
        'info': 'rgb(var(--info) / <alpha-value>)',
      },

      borderRadius: { DEFAULT: '0.25rem', lg: '0.5rem', xl: '0.75rem', full: '9999px' },

      spacing: {
        base: '4px',
        xs: '8px',
        sm: '12px',
        gutter: '16px',
        md: '20px',
        lg: '32px',
        xl: '48px',
        'margin-mobile': '16px',
        'margin-desktop': '40px',
      },

      fontFamily: {
        'body-md': ['Inter', 'sans-serif'],
        'body-lg': ['Inter', 'sans-serif'],
        'label-caps': ['Inter', 'sans-serif'],
        // §18 requires tabular figures so money doesn't jitter as it ticks.
        'data-mono': ['JetBrains Mono', 'monospace'],
        'headline-md': ['Sora', 'sans-serif'],
        'display-lg': ['Sora', 'sans-serif'],
        'display-lg-mobile': ['Sora', 'sans-serif'],
      },

      fontSize: {
        'body-md': ['16px', { lineHeight: '1.6', fontWeight: '400' }],
        'body-lg': ['18px', { lineHeight: '1.6', fontWeight: '400' }],
        'data-mono': ['14px', { lineHeight: '1.4', letterSpacing: '0.04em', fontWeight: '500' }],
        'label-caps': ['12px', { lineHeight: '1', letterSpacing: '0.06em', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '1.3', fontWeight: '700' }],
        'display-lg': ['48px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '800' }],
        'display-lg-mobile': ['32px', { lineHeight: '1.2', fontWeight: '800' }],
      },
    },
  },
  plugins: [forms],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1f2a2e', soft: '#3b484d', mute: '#5f6b70' },
        paper: { DEFAULT: '#faf7f2', card: '#ffffff', line: '#e7e0d4', shade: '#f2ece2' },
        food: { DEFAULT: '#a84a24', soft: '#f7e6dc', ink: '#7a3216' },
        bar: { DEFAULT: '#0f5e63', soft: '#dcefef', ink: '#0a4245' },
        ok: { DEFAULT: '#2f6b3a', soft: '#e3f1e5' },
        warn: { DEFAULT: '#8a5a00', soft: '#fbf0d7' },
        risk: { DEFAULT: '#a2401c', soft: '#fbe5da' },
        review: { DEFAULT: '#5b3f8c', soft: '#ece6f6' },
        block: { DEFAULT: '#8f1d2c', soft: '#f8e1e4' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        serif: ['ui-serif', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
      },
    },
  },
  plugins: [],
};

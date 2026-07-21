/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0a12',
        panel: '#12121f',
        neon: {
          purple: '#8b5cf6',
          indigo: '#6366f1',
          cyan: '#22d3ee',
        },
      },
      boxShadow: {
        'neon-purple': '0 0 20px rgba(139,92,246,.45)',
        'neon-cyan': '0 0 20px rgba(34,211,238,.35)',
      },
      backgroundImage: {
        'neon-grad': 'linear-gradient(135deg,#8b5cf6 0%,#6366f1 50%,#22d3ee 100%)',
      },
    },
  },
  plugins: [],
}

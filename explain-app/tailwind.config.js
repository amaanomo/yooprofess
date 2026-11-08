/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{jsx,js,ts,tsx}', './explain.html'],
  theme: {
    extend: {
      colors: {
        void: '#07080f',
        space: {
          DEFAULT: '#0d0f1c',
          800: '#131629',
          700: '#1a1f38',
          600: '#252a4d',
        },
        nebula: {
          DEFAULT: '#7c3aed',
          600: '#6d28d9',
          500: '#8b5cf6',
        },
        comet: '#a78bfa',
        aurora: '#67e8f9',
        pulse: '#c084fc',
        star: '#f0e6ff',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

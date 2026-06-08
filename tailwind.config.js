/** @type {import('tailwindcss').Config} */
export default {
  content: ['./entrypoints/**/*.{html,tsx,ts,jsx,js}', './components/**/*.{tsx,ts}'],
  theme: {
    extend: {
      colors: {
        nlm: {
          blue: '#1a73e8',
          surface: '#f8f9fa',
          border: '#dadce0',
        },
      },
    },
  },
  plugins: [],
};

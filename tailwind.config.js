/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './script.js'],
  safelist: [
    'bg-green-500',
    'bg-red-500',
    'text-green-700',
    'dark:text-green-400',
    'text-red-700',
    'dark:text-red-400',
    'text-green-600',
    'text-red-600'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

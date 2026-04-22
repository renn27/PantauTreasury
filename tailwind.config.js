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
    'text-red-600',
    // Simulation template dynamic classes
    'from-green-50', 'to-emerald-50', 'dark:from-green-900/20', 'dark:to-emerald-900/20',
    'from-red-50', 'to-rose-50', 'dark:from-red-900/20', 'dark:to-rose-900/20',
    'text-red-600', 'dark:text-red-400',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

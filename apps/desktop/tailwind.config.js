/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./renderer/app/**/*.{js,ts,jsx,tsx}",
    "./renderer/components/**/*.{js,ts,jsx,tsx}",
    "./renderer/stores/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        darkBg: "#08090c",
        darkCard: "#11131c",
        darkBorder: "#1e2230",
        accentPurple: "#8a2be2",
        accentBlue: "#0070f3",
        accentGreen: "#00df72",
        glassBg: "rgba(17, 19, 28, 0.75)",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        display: ["Outfit", "sans-serif"],
      },
    },
  },
  plugins: [],
};

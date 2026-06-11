module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      require("react-native-css-interop/dist/babel-plugin").default,
      "react-native-worklets/plugin",
    ],
  };
};

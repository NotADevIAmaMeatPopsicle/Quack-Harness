module.exports = {
  extends: ["../.eslintrc.json"],
  parserOptions: {
    project: "./tsconfig.app.json",
    tsconfigRootDir: __dirname,
  },
};

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/runtime-dist/**",
      "**/coverage/**",
      "**/public/**",
      "**/quiver/**",
      ".mimocode/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 纯风格噪音关闭
      "no-empty-function": "off",
      "@typescript-eslint/no-empty-function": "off",
      // 仓里存在合理的 any，先按 warn 处理
      "@typescript-eslint/no-explicit-any": "warn",
      // 未使用变量按 error 处理，允许下划线前缀显式忽略
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: [
      "apps/server/**",
      "apps/desktop/**",
      "apps/site/**",
      "packages/**",
      "scripts/**",
      "*.config.*",
      "*.mjs"
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["apps/admin/**", "apps/site/src/assets/**"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    // 站点构建时会把该文件里的占位符文本替换为实际值
    files: ["apps/site/src/assets/**"],
    languageOptions: {
      globals: {
        __PROTECTED_CONTENT_VERSION__: "readonly"
      }
    }
  },
  {
    // react-hooks 规则只对 tsx/jsx 与 hooks 文件生效
    files: ["**/*.{tsx,jsx}", "**/hooks/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: reactHooks.configs["recommended-latest"].rules
  }
);

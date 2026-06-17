import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "WazzapAgents",
  tagline:
    "Bot WhatsApp berbasis AI yang bisa diajak ngobrol, moderasi grup, dan disesuaikan sesukamu.",
  favicon: "img/favicon.ico",

  url: "https://chomosuke9.github.io",
  baseUrl: "/WazzapAgent/",

  organizationName: "Chomosuke9",
  projectName: "WazzapAgent",
  trailingSlash: false,

  onBrokenLinks: "throw",
  markdown: {
    format: "detect",
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
    mdx1Compat: {
      comments: true,
      admonitions: true,
      headingIds: true,
    },
    anchors: {
      maintainCase: true,
    },
  },

  i18n: {
    defaultLocale: "id",
    locales: ["id", "en"],
    localeConfigs: {
      id: { label: "Bahasa Indonesia" },
      en: { label: "English" },
    },
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "WazzapAgents",
      logo: {
        alt: "WazzapAgents Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "tutorialSidebar",
          position: "left",
          label: "Panduan",
        },
        {
          type: "localeDropdown",
          position: "right",
        },
        {
          href: "https://github.com/Chomosuke9/WazzapAgent",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Panduan",
          items: [
            { label: "Mulai di Sini", to: "/pengantar" },
            { label: "Semua Perintah", to: "/penggunaan/perintah" },
            { label: "Contoh Prompt", to: "/penggunaan/contoh-prompt" },
          ],
        },
        {
          title: "Developer",
          items: [
            { label: "Arsitektur", to: "/dev/arsitektur" },
            { label: "Instalasi", to: "/instalasi" },
            { label: "Protokol WebSocket", to: "/dev/protokol" },
          ],
        },
        {
          title: "Lainnya",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/Chomosuke9/WazzapAgent",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} WazzapAgents.`,
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.nightOwl,
      additionalLanguages: ["bash", "diff", "json", "python", "typescript"],
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

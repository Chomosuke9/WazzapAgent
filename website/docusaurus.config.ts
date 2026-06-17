import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "WazzapAgents",
  tagline:
    "An AI-powered WhatsApp bot you can chat with, moderate groups, and customize however you like.",
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
    defaultLocale: "en",
    locales: ["en"],
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
    image: "img/check_success.png",
    metadata: [
      {
        name: "description",
        content:
          "An AI-powered WhatsApp bot for chatting, group moderation, stickers, quizzes, and slash commands. Open source and multi-account.",
      },
      {
        name: "keywords",
        content:
          "whatsapp bot, ai, chatbot, baileys, llm, group moderation, open source, wazzapagents",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    announcementBar: {
      id: "star-on-github",
      content:
        '⭐ Like WazzapAgents? Give it a star on <a target="_blank" rel="noopener noreferrer" href="https://github.com/Chomosuke9/WazzapAgent">GitHub</a> to support the project!',
      isCloseable: true,
    },
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
          label: "Guide",
        },
        {
          href: "https://github.com/Chomosuke9/WazzapAgent",
          position: "right",
          className: "header-github-link",
          "aria-label": "GitHub repository",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Guide",
          items: [
            { label: "Get Started", to: "/" },
            { label: "All Commands", to: "/usage/commands" },
            { label: "Prompt Examples", to: "/usage/prompt-examples" },
          ],
        },
        {
          title: "Developer",
          items: [
            { label: "Architecture", to: "/dev/architecture" },
            { label: "Installation", to: "/installation" },
            { label: "WebSocket Protocol", to: "/dev/protocol" },
          ],
        },
        {
          title: "More",
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

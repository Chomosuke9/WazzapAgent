import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    {
      type: "doc",
      id: "index",
      label: "Introduction",
    },
    {
      type: "category",
      label: "Installation",
      link: {
        type: "doc",
        id: "installation/index",
      },
      items: ["installation/getting-started", "installation/how-to-get-lid"],
    },
    {
      type: "category",
      label: "Settings & Usage",
      items: [
        "usage/commands",
        "usage/permission",
        "usage/prompt",
        "usage/prompt-examples",
        "usage/features",
        "usage/tips",
        "usage/faq",
      ],
    },
    {
      type: "category",
      label: "Developer Documentation",
      items: [
        "dev/architecture",
        "dev/setup",
        "dev/gateway",
        "dev/bridge",
        "dev/protocol",
        "dev/contributing",
      ],
    },
  ],
};

export default sidebars;

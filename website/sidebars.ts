import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    {
      type: "doc",
      id: "index",
      label: "Pengantar",
    },
    {
      type: "category",
      label: "Instalasi",
      link: {
        type: "doc",
        id: "instalasi/index",
      },
      items: ["instalasi/memulai", "instalasi/cara-mendapatkan-lid"],
    },
    {
      type: "category",
      label: "Pengaturan & Penggunaan",
      items: [
        "penggunaan/perintah",
        "penggunaan/permission",
        "penggunaan/prompt",
        "penggunaan/contoh-prompt",
        "penggunaan/fitur",
        "penggunaan/tips",
        "penggunaan/faq",
      ],
    },
    {
      type: "category",
      label: "Dokumentasi Developer",
      items: [
        "dev/arsitektur",
        "dev/setup",
        "dev/gateway",
        "dev/bridge",
        "dev/protokol",
        "dev/kontribusi",
      ],
    },
  ],
};

export default sidebars;

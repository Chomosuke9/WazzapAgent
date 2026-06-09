import type { ReactNode } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import Translate, { translate } from "@docusaurus/Translate";
import styles from "./index.module.css";

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx("hero hero--primary", styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">
          <Translate id="homepage.tagline">
            Bot WhatsApp berbasis AI yang bisa diajak ngobrol, moderasi grup,
            dan disesuaikan sesukamu.
          </Translate>
        </p>
        <div className={styles.buttons}>
          <Link className="button button--secondary button--lg" to="/pengantar">
            <Translate id="homepage.cta.getStarted">Mulai Sekarang</Translate>
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/penggunaan/perintah"
            style={{ color: "#fff", borderColor: "#fff" }}
          >
            <Translate id="homepage.cta.viewCommands">Lihat Perintah</Translate>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Feature({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <div className={clsx("col col--4")}>
      <div
        className="feature-card"
        style={{
          textAlign: "center",
          paddingTop: "1.5rem",
          paddingBottom: "1.5rem",
        }}
      >
        <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>
          {icon}
        </div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      num: "1",
      title: translate({
        id: "homepage.howItWorks.step1.title",
        message: "Tambahkan Bot",
      }),
      desc: translate({
        id: "homepage.howItWorks.step1.desc",
        message:
          "Masukkan nomor bot ke grup WhatsApp-mu seperti menambah anggota biasa.",
      }),
    },
    {
      num: "2",
      title: translate({
        id: "homepage.howItWorks.step2.title",
        message: "Atur Prompt",
      }),
      desc: translate({
        id: "homepage.howItWorks.step2.desc",
        message: "Tentukan kepribadian dan aturan bot dengan perintah /prompt.",
      }),
    },
    {
      num: "3",
      title: translate({
        id: "homepage.howItWorks.step3.title",
        message: "Siap Digunakan!",
      }),
      desc: translate({
        id: "homepage.howItWorks.step3.desc",
        message:
          "Bot langsung aktif dan bisa diajak ngobrol oleh semua anggota grup.",
      }),
    },
  ];

  return (
    <section className="how-it-works">
      <div className="container">
        <Heading as="h2" style={{ textAlign: "center", marginBottom: "2rem" }}>
          <Translate id="homepage.howItWorks.title">Cara Kerja</Translate>
        </Heading>
        <div className="row" style={{ justifyContent: "center" }}>
          {steps.map((step, idx) => (
            <div
              key={idx}
              className="col col--3"
              style={{ textAlign: "center", padding: "1rem" }}
            >
              <div className="step-number">{step.num}</div>
              <Heading as="h4">{step.title}</Heading>
              <p style={{ fontSize: "0.95rem" }}>{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const features = [
  {
    title: translate({
      id: "homepage.feature1.title",
      message: "Asisten AI di WhatsApp",
    }),
    description: translate({
      id: "homepage.feature1.desc",
      message:
        "Bot berbasis AI yang bisa mengobrol natural, menjawab pertanyaan, bercanda, dan membantu anggota grup.",
    }),
    icon: "🤖",
  },
  {
    title: translate({
      id: "homepage.feature2.title",
      message: "Moderasi Otomatis",
    }),
    description: translate({
      id: "homepage.feature2.desc",
      message:
        "Bisa menghapus pesan spam atau mengeluarkan anggota nakal secara otomatis sesuai aturan yang kamu set.",
    }),
    icon: "🛡️",
  },
  {
    title: translate({
      id: "homepage.feature3.title",
      message: "Sepenuhnya Bisa Dikustomisasi",
    }),
    description: translate({
      id: "homepage.feature3.desc",
      message:
        "Atur kepribadian, peran, dan aturan bot dengan perintah /prompt. Berbeda di setiap grup.",
    }),
    icon: "🎨",
  },
];

export default function Home(): ReactNode {
  return (
    <Layout
      title={translate({
        id: "homepage.layout.title",
        message: "Panduan Pengguna",
      })}
      description={translate({
        id: "homepage.layout.description",
        message:
          "Dokumentasi lengkap cara menggunakan WazzapAgents — bot WhatsApp berbasis AI",
      })}
    >
      <HomepageHeader />
      <main>
        <section style={{ padding: "3rem 0" }}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
        <HowItWorks />
      </main>
    </Layout>
  );
}

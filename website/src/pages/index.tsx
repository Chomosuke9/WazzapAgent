import type { ReactNode } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useBaseUrl from "@docusaurus/useBaseUrl";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import Translate, { translate } from "@docusaurus/Translate";
import styles from "./index.module.css";

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  const heroImage = useBaseUrl("/img/slash_info.jpg");
  return (
    <header className={clsx("hero hero--primary", styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroRow}>
          <div className={styles.heroText}>
            <div className={styles.badges}>
              <span className={styles.badge}>
                <Translate id="homepage.badge.aiWhatsapp">
                  AI · WhatsApp
                </Translate>
              </span>
              <span className={styles.badge}>
                <Translate id="homepage.badge.openSource">
                  Open Source
                </Translate>
              </span>
              <span className={styles.badge}>
                <Translate id="homepage.badge.multiAccount">
                  Multi-akun
                </Translate>
              </span>
            </div>
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
              <Link
                className="button button--secondary button--lg"
                to="/pengantar"
              >
                <Translate id="homepage.cta.getStarted">
                  Mulai Sekarang
                </Translate>
              </Link>
              <Link
                className={clsx(
                  "button button--outline button--lg",
                  styles.heroOutlineButton,
                )}
                to="/penggunaan/perintah"
              >
                <Translate id="homepage.cta.viewCommands">
                  Lihat Perintah
                </Translate>
              </Link>
            </div>
          </div>
          <div className={styles.heroImage}>
            <img
              src={heroImage}
              alt={translate({
                id: "homepage.hero.imageAlt",
                message:
                  "Tangkapan layar bot WhatsApp WazzapAgents menampilkan perintah /info",
              })}
              loading="eager"
            />
          </div>
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
      <div className={clsx("feature-card", styles.featureCard)}>
        <div className={styles.featureIcon}>{icon}</div>
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
        <Heading as="h2" className={styles.sectionHeading}>
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

function Showcase() {
  const shots = [
    {
      src: useBaseUrl("/img/slash_setting.jpg"),
      caption: translate({
        id: "homepage.showcase.settings.caption",
        message: "Atur perilaku bot per-grup lewat menu /setting.",
      }),
      alt: translate({
        id: "homepage.showcase.settings.alt",
        message: "Tangkapan layar menu pengaturan /setting",
      }),
    },
    {
      src: useBaseUrl("/img/gpt_model.jpg"),
      caption: translate({
        id: "homepage.showcase.model.caption",
        message: "Pilih model AI favoritmu untuk tiap percakapan.",
      }),
      alt: translate({
        id: "homepage.showcase.model.alt",
        message: "Tangkapan layar konfigurasi model AI",
      }),
    },
    {
      src: useBaseUrl("/img/check_success.png"),
      caption: translate({
        id: "homepage.showcase.success.caption",
        message: "Verifikasi koneksi yang berhasil dengan cepat.",
      }),
      alt: translate({
        id: "homepage.showcase.success.alt",
        message: "Tangkapan layar status koneksi berhasil",
      }),
    },
  ];

  return (
    <section className={styles.showcase}>
      <div className="container">
        <Heading as="h2" className={styles.sectionHeading}>
          <Translate id="homepage.showcase.title">Lihat Langsung</Translate>
        </Heading>
        <p className={styles.sectionSubheading}>
          <Translate id="homepage.showcase.subtitle">
            Cuplikan WazzapAgents saat beraksi di WhatsApp.
          </Translate>
        </p>
        <div className={styles.showcaseGrid}>
          {shots.map((shot, idx) => (
            <figure key={idx} className={styles.showcaseItem}>
              <img src={shot.src} alt={shot.alt} loading="lazy" />
              <figcaption>{shot.caption}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className={styles.ctaBand}>
      <div className="container">
        <Heading as="h2" className={styles.ctaTitle}>
          <Translate id="homepage.ctaBand.title">
            Siap menghidupkan grup WhatsApp-mu?
          </Translate>
        </Heading>
        <p className={styles.ctaSubtitle}>
          <Translate id="homepage.ctaBand.subtitle">
            Pasang WazzapAgents dalam beberapa menit dan mulai mengobrol dengan
            AI.
          </Translate>
        </p>
        <Link className="button button--secondary button--lg" to="/instalasi">
          <Translate id="homepage.ctaBand.button">Pasang Sekarang</Translate>
        </Link>
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
        <section className={styles.featuresSection}>
          <div className="container">
            <Heading as="h2" className={styles.sectionHeading}>
              <Translate id="homepage.features.title">
                Kenapa WazzapAgents?
              </Translate>
            </Heading>
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
        <HowItWorks />
        <Showcase />
        <CtaBand />
      </main>
    </Layout>
  );
}

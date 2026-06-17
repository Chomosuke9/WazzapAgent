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
                  Multi-account
                </Translate>
              </span>
            </div>
            <Heading as="h1" className="hero__title">
              {siteConfig.title}
            </Heading>
            <p className="hero__subtitle">
              <Translate id="homepage.tagline">
                An AI-powered WhatsApp bot you can chat with, moderate groups,
                and customize however you like.
              </Translate>
            </p>
            <div className={styles.buttons}>
              <Link
                className="button button--secondary button--lg"
                to="/"
              >
                <Translate id="homepage.cta.getStarted">
                  Get Started
                </Translate>
              </Link>
              <Link
                className={clsx(
                  "button button--outline button--lg",
                  styles.heroOutlineButton,
                )}
                to="/usage/commands"
              >
                <Translate id="homepage.cta.viewCommands">
                  View Commands
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
                  "Screenshot of the WazzapAgents WhatsApp bot showing the /info command",
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
        message: "Add the Bot",
      }),
      desc: translate({
        id: "homepage.howItWorks.step1.desc",
        message:
          "Add the bot's number to your WhatsApp group just like adding a regular member.",
      }),
    },
    {
      num: "2",
      title: translate({
        id: "homepage.howItWorks.step2.title",
        message: "Set the Prompt",
      }),
      desc: translate({
        id: "homepage.howItWorks.step2.desc",
        message: "Define the bot's personality and rules with the /prompt command.",
      }),
    },
    {
      num: "3",
      title: translate({
        id: "homepage.howItWorks.step3.title",
        message: "Ready to Use!",
      }),
      desc: translate({
        id: "homepage.howItWorks.step3.desc",
        message:
          "The bot is instantly active and ready to chat with all group members.",
      }),
    },
  ];

  return (
    <section className="how-it-works">
      <div className="container">
        <Heading as="h2" className={styles.sectionHeading}>
          <Translate id="homepage.howItWorks.title">How It Works</Translate>
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
        message: "Configure per-group bot behavior via the /setting menu.",
      }),
      alt: translate({
        id: "homepage.showcase.settings.alt",
        message: "Screenshot of the /setting settings menu",
      }),
    },
    {
      src: useBaseUrl("/img/gpt_model.jpg"),
      caption: translate({
        id: "homepage.showcase.model.caption",
        message: "Pick your favorite AI model for each conversation.",
      }),
      alt: translate({
        id: "homepage.showcase.model.alt",
        message: "Screenshot of the AI model configuration",
      }),
    },
    {
      src: useBaseUrl("/img/check_success.png"),
      caption: translate({
        id: "homepage.showcase.success.caption",
        message: "Quickly verify a successful connection.",
      }),
      alt: translate({
        id: "homepage.showcase.success.alt",
        message: "Screenshot of a successful connection status",
      }),
    },
  ];

  return (
    <section className={styles.showcase}>
      <div className="container">
        <Heading as="h2" className={styles.sectionHeading}>
          <Translate id="homepage.showcase.title">See It in Action</Translate>
        </Heading>
        <p className={styles.sectionSubheading}>
          <Translate id="homepage.showcase.subtitle">
            Snapshots of WazzapAgents in action on WhatsApp.
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
            Ready to bring your WhatsApp group to life?
          </Translate>
        </Heading>
        <p className={styles.ctaSubtitle}>
          <Translate id="homepage.ctaBand.subtitle">
            Set up WazzapAgents in minutes and start chatting with AI.
          </Translate>
        </p>
        <Link className="button button--secondary button--lg" to="/installation">
          <Translate id="homepage.ctaBand.button">Install Now</Translate>
        </Link>
      </div>
    </section>
  );
}

const features = [
  {
    title: translate({
      id: "homepage.feature1.title",
      message: "AI Assistant on WhatsApp",
    }),
    description: translate({
      id: "homepage.feature1.desc",
      message:
        "An AI-powered bot that chats naturally, answers questions, jokes around, and helps group members.",
    }),
    icon: "🤖",
  },
  {
    title: translate({
      id: "homepage.feature2.title",
      message: "Automatic Moderation",
    }),
    description: translate({
      id: "homepage.feature2.desc",
      message:
        "Can delete spam messages or remove troublesome members automatically according to the rules you set.",
    }),
    icon: "🛡️",
  },
  {
    title: translate({
      id: "homepage.feature3.title",
      message: "Fully Customizable",
    }),
    description: translate({
      id: "homepage.feature3.desc",
      message:
        "Set the bot's personality, role, and rules with the /prompt command. Different for each group.",
    }),
    icon: "🎨",
  },
];

export default function Home(): ReactNode {
  return (
    <Layout
      title={translate({
        id: "homepage.layout.title",
        message: "User Guide",
      })}
      description={translate({
        id: "homepage.layout.description",
        message:
          "Complete documentation on how to use WazzapAgents — an AI-powered WhatsApp bot",
      })}
    >
      <HomepageHeader />
      <main>
        <section className={styles.featuresSection}>
          <div className="container">
            <Heading as="h2" className={styles.sectionHeading}>
              <Translate id="homepage.features.title">
                Why WazzapAgents?
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

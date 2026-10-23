import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import heroBg from "@/imports/890e88bf-8d8b-40b5-94af-aaa454a0cfb3.mp4";
import uwSeal from "@/assets/uw-seal.svg";
import avatarImg from "@/assets/avatar.jpg";
import gradAvatar from "@/assets/grad-avatar.png";
import aecDailyLogo from "@/assets/logos/aec-daily-logo.jpeg";
import adpLogo from "@/assets/logos/adp-logo.jpg";
import netdragonLogo from "@/assets/logos/netdragon-logo.png";
import { supabase } from "@/app/lib/supabase";
import {
  ChevronLeft, ChevronRight, X, Send, Download, ExternalLink,
  Github, Linkedin, Mail, Volume2, VolumeX,
  Terminal, Code2, Database, Wrench, Brain,
  MapPin, Zap, Menu, ArrowDown,
} from "lucide-react";

// ─── DATA ────────────────────────────────────────────────────────────────────

const NAV_LINKS = ["HOME", "PROFILE", "JOURNEY", "SKILLS", "PROJECTS", "CONTACT"];
const SECTION_IDS = ["home", "profile", "journey", "skills", "projects", "contact"];

const JOURNEY = [
  {
    year: "2024",
    period: "Full-time \nMay 2024 – Present",
    role: "Full Stack Engineer",
    company: "AEC Daily · Newmarket, ON",
    logo: aecDailyLogo,
    bullets: [
      "Led development and delivery of multiple white-label e-university and compliance-training portals, owning the application, PostgreSQL database, tenant configuration, and deployment stack; built hostname-based routing that loads client-specific branding and configuration while sharing centralized course data and core functionality, and standardized provisioning across config, templates, data setup, and release rollout.",
      "Investigated and remediated two blind SQL injection vulnerabilities, eliminating the attack surface by sourcing user identity from session state instead of client input; designed a centralized, boundary-level parameter sanitization layer replacing 4 scattered validation points. Fixed a privilege-escalation vulnerability where staff access was inferred from unverified email domain matching, replacing it with an explicit authorization flag in the user schema.",
      "Led design and delivery of the platform's internationalization and localization infrastructure, including multilingual content modeling, ordered language preferences, gettext workflows, and localized template rendering; designed a preference chain that falls back to a user's next language when content is unavailable and extended the same logic to interface text, standardizing user-facing strings behind translation tags.",
      "Audited compliance-critical deadline and completion logic, identifying data-integrity gaps and documenting reproducible cases for engineering follow-up; built automated sanity checks to catch localization and formatting issues before production, and mentored junior developers while coordinating releases.",
    ],
  },
  {
    year: "2023",
    period: "Internship\nJan – Apr 2023",
    role: "Full Stack Engineer Intern",
    company: "AEC Daily · Newmarket, ON",
    logo: aecDailyLogo,
    bullets: [
      "Developed a dynamic Recommended Courses feature using PHP, Smarty, and SQL, querying course relationships and user-relevant data to surface recommended and related courses and improve content discovery.",
      "Designed and implemented an interactive \"Leave a Question\" feature on course pages using PHP, Smarty, HTML, and CSS, enabling users to submit inquiries and automatically notifying instructors by email.",
      "Performed comprehensive black-box testing across the company website, identifying, reproducing, and documenting functional defects and usability issues that contributed to improved product quality and user experience.",
      "Collaborated with developers to investigate reported defects, validate fixes, and implement system enhancements based on test findings, supporting more reliable releases and continuous product improvement.",
    ],
  },
  {
    year: "2022",
    period: "Co-op\nMay – Aug. 2022",
    role: "Software Engineer Intern",
    company: "Lifion by ADP · New York, NY",
    logo: adpLogo,
    bullets: [
      "Extended an internal low-code workflow engine used by non-technical staff to configure server-side business logic, adding conditional operators that expanded the range of business rules users could define without writing code.",
      "Redesigned the application's results interface to display more detailed workflow execution outputs, improving visibility into runtime behavior and helping users validate and troubleshoot configured workflows.",
      "Developed integration tests within the team's Jenkins CI pipeline, achieving over 90% test coverage for newly introduced functionality and reducing regression risk during subsequent releases.",
    ],
  },
  {
    year: "2020",
    period: "Co-op\nSept. 2020 – Aug. 2021",
    role: "Software Test Engineer",
    company: "NetDragon Websoft Holdings · Fuzhou, China",
    logo: netdragonLogo,
    bullets: [
      "Built an automated UI testing framework for ActivPanel that simulated user interactions and validated on-screen responses, detecting functional defects before production release and improving confidence in product stability.",
      "Executed regression and feature testing across three product launches, documented and tracked defects in JIRA, and prepared release-readiness reports to support go/no-go decisions and prioritize critical issues before deployment.",
    ],
  },
];

const EDUCATION = {
  school: "University of Waterloo",
  location: "Waterloo, Ontario",
  degree: "Bachelor of Mathematics",
  period: "Sept 2018 – Aug 2023",
  major: "Computational Mathematics · Combinatorics & Optimization Minor · Computing Minor",
  courses: ["Algorithm Problem Solving & Data Abstraction", "Data Types and Structures", "Object-Oriented Software Development", "Data-Intensive Distributed Computing", "Applied Cryptography", "Game Theory"],
};

const SKILLS = [
  { id: "01", label: "LANGUAGES", Icon: Code2, status: "ACTIVE", items: ["Python", "JavaScript", "PHP", "C / C++", "Dart", "R", "HTML / CSS"] },
  { id: "02", label: "BACKEND", Icon: Terminal, status: "ACTIVE", items: ["Node.js", "Flask", "REST API", "WebRTC", "WebSockets", "JWT Auth"] },
  { id: "03", label: "FRONTEND & MOBILE", Icon: Wrench, status: "ACTIVE", items: ["Flutter", "Swift / WidgetKit", "Smarty Templates"] },
  { id: "04", label: "DATABASE & CLOUD", Icon: Database, status: "STABLE", items: ["PostgreSQL", "SQLite / Drift", "Tencent CloudBase", "CDN"] },
  { id: "05", label: "DEVOPS & TOOLS", Icon: Brain, status: "ENHANCED", items: ["Docker", "Jenkins", "CI/CD", "Xcode Cloud", "Linux", "Git", "Jira", "VS Code"] },
];

const PROJECTS = [
  {
    id: "01", name: "CELPIP Practice Platform", type: "EdTech · Full-Stack",
    desc: "Production-ready English exam platform with AI scoring, WebRTC speaking assessments, and real-time progress — serving 500+ concurrent users at deercelpip.com.",
    bullets: [
      "Architected a production English exam practice platform with 30+ Flask REST APIs, powering test delivery, user submissions, AI-based scoring, personalized feedback, and speech-to-text transcription.",
      "Designed PostgreSQL schemas, indexing, and transaction handling to maintain data consistency under concurrent submissions, supporting thousands of learners with sub-second response times.",
      "Secured the platform end-to-end with JWT authentication, PBKDF2 password hashing, Fernet encryption, and defenses against SQL injection and XSS.",
      "Reduced page-load time by 60% through CDN delivery, caching, and compression; validated platform stability under 500+ concurrent users through load testing.",
    ],
    color: "#8b5cf6",
    link: "https://www.deercelpip.com",
    tech: ["JavaScript", "Python", "Flask", "PostgreSQL", "WebRTC", "Docker", "WebSockets"],
    img: "https://images.unsplash.com/photo-1501504905252-473c47e087f8?w=900&h=600&fit=crop&auto=format&q=80",
  },
  {
    id: "02", name: "Aya Calendar", type: "Mobile · Couples App",
    desc: "Local-first couples productivity app with offline-first SQLite sync, native iOS Home Screen Widgets in Swift/WidgetKit, and a serverless CloudBase backend.",
    bullets: [
      "Built a local-first Flutter application using Drift (SQLite) with incremental Tencent CloudBase synchronization, implementing last-write-wins conflict resolution to reconcile offline edits across calendar, mood, and journal modules.",
      "Developed CloudBase serverless functions handling authentication, data synchronization, and partner-interaction features such as habit-tracking check-ins and notifications.",
      "Created native iOS Home Screen Widgets with Swift and WidgetKit and automated iOS builds and releases through Xcode Cloud.",
    ],
    color: "#ec4899",
    tech: ["Flutter", "Dart", "Swift", "WidgetKit", "Tencent CloudBase", "Xcode Cloud"],
    img: "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=900&h=600&fit=crop&auto=format&q=80",
  },
];

const PROFILE_TABS = ["Character Profile", "Working Philosophy", "Personal Interests"];

// ─── SHARED STYLES ────────────────────────────────────────────────────────────

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };
const body = { fontFamily: "'Inter', sans-serif" };

// ─── BACKGROUND DECORATION ───────────────────────────────────────────────────

function GridOverlay() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        backgroundImage:
          "linear-gradient(rgba(139,92,246,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,0.05) 1px,transparent 1px)",
        backgroundSize: "52px 52px",
      }}
    />
  );
}

function ScanLines() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-10"
      style={{
        backgroundImage:
          "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.12) 3px,rgba(0,0,0,0.12) 4px)",
        opacity: 0.5,
      }}
    />
  );
}

function Vignette() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-10"
      style={{ background: "radial-gradient(ellipse at center,transparent 30%,rgba(6,10,20,0.82) 100%)" }}
    />
  );
}

// ─── NAVBAR ──────────────────────────────────────────────────────────────────

function Navbar({
  active, scrollTo, soundOn, setSoundOn,
}: {
  active: string; scrollTo: (id: string) => void;
  soundOn: boolean; setSoundOn: (v: boolean) => void;
}) {
  const [lang, setLang] = useState<"CN" | "EN">("EN");
  const [mobileOpen, setMobileOpen] = useState(false);
  const avatarClicksRef = useRef(0);
  const avatarClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAvatarClick = () => {
    avatarClicksRef.current += 1;
    if (avatarClickTimerRef.current) clearTimeout(avatarClickTimerRef.current);
    if (avatarClicksRef.current >= 3) {
      avatarClicksRef.current = 0;
      // /login 由另一个 Worker(私有交易系统)接管,所以整页跳转而不是路由内导航
      window.location.href = "/login";
      return;
    }
    avatarClickTimerRef.current = setTimeout(() => {
      avatarClicksRef.current = 0;
    }, 600);
  };

  return (
    <>
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 lg:px-10 h-16"
        style={{
          background: "rgba(6,10,20,0.85)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(139,92,246,0.18)",
        }}
      >
        {/* Left — logo + name */}
        <div className="flex items-center gap-3 min-w-0">
          <img
            src={gradAvatar}
            alt="Shutao"
            onClick={handleAvatarClick}
            className="w-9 h-9 rounded-full object-cover flex-shrink-0 cursor-pointer select-none"
            style={{ border: "1px solid rgba(139,92,246,0.5)" }}
          />
          <div className="hidden sm:flex flex-col leading-none">
            <span className="text-white font-semibold text-sm" style={display}>SHUTAO</span>
            <span className="text-[10px] text-violet-400" style={mono}>V2026</span>
          </div>
        </div>

        {/* Center — nav links */}
        <div className="hidden lg:flex items-center gap-1" style={mono}>
          {NAV_LINKS.map((item, i) => {
            const id = SECTION_IDS[i];
            const isActive = active === id;
            return (
              <button
                key={item}
                onClick={() => scrollTo(id)}
                className="relative px-4 py-1.5 text-[11px] font-medium tracking-widest transition-colors duration-200"
                style={{ color: isActive ? "#fff" : "#6b7fa8" }}
              >
                {isActive && (
                  <motion.span
                    layoutId="navpill"
                    className="absolute inset-0 rounded-full"
                    style={{ background: "rgba(139,92,246,0.3)", border: "1px solid rgba(139,92,246,0.5)" }}
                    transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <span className="relative">{item}</span>
              </button>
            );
          })}
        </div>

        {/* Right — controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundOn(!soundOn)}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] transition-colors"
            style={{ ...mono, color: "#6b7fa8", border: "1px solid rgba(139,92,246,0.15)" }}
          >
            {soundOn ? <Volume2 size={12} /> : <VolumeX size={12} />}
            <span>{soundOn ? "ON" : "OFF"}</span>
          </button>
          <button
            onClick={() => setLang(lang === "CN" ? "EN" : "CN")}
            className="hidden sm:flex px-2.5 py-1.5 rounded text-[11px] transition-colors"
            style={{ ...mono, color: "#6b7fa8", border: "1px solid rgba(139,92,246,0.15)" }}
          >
            {lang}
          </button>
          <button
            onClick={() => scrollTo("contact")}
            className="hidden md:flex px-4 py-1.5 rounded text-[11px] font-semibold tracking-widest transition-all hover:bg-violet-600/20"
            style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.45)" }}
          >
            TALK TO ME
          </button>
          <button
            className="lg:hidden p-2 text-violet-400"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex flex-col"
            style={{ background: "rgba(6,10,20,0.97)", backdropFilter: "blur(24px)" }}
          >
            <div className="flex justify-end p-6">
              <button onClick={() => setMobileOpen(false)} className="text-violet-400">
                <X size={24} />
              </button>
            </div>
            <div className="flex flex-col items-center justify-center gap-6 flex-1">
              {NAV_LINKS.map((item, i) => (
                <button
                  key={item}
                  onClick={() => { scrollTo(SECTION_IDS[i]); setMobileOpen(false); }}
                  className="text-3xl font-black tracking-widest transition-colors hover:text-violet-400"
                  style={{ ...display, color: active === SECTION_IDS[i] ? "#a78bfa" : "#e2e8f4" }}
                >
                  {item}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── HERO SECTION ────────────────────────────────────────────────────────────

function HeroSection({ scrollTo }: { scrollTo: (id: string) => void }) {
  return (
    <section
      id="home"
      data-section="home"
      className="relative min-h-screen flex items-end pb-20 pt-16 overflow-hidden"
    >
      {/* ── Full-screen video background ── */}
      <video
        src={heroBg}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{ opacity: 0.55 }}
      />

      {/* Left-to-right gradient: solid dark on left fading to transparent on right */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(100deg, rgba(6,10,20,0.97) 0%, rgba(6,10,20,0.88) 30%, rgba(6,10,20,0.55) 58%, rgba(6,10,20,0.15) 100%)",
        }}
      />
      {/* Bottom fade into next section */}
      <div
        className="absolute bottom-0 left-0 right-0 h-40"
        style={{ background: "linear-gradient(to top, #060a14 0%, transparent 100%)" }}
      />
      {/* Top fade from navbar */}
      <div
        className="absolute top-0 left-0 right-0 h-24"
        style={{ background: "linear-gradient(to bottom, rgba(6,10,20,0.7) 0%, transparent 100%)" }}
      />

      {/* Side vertical text — far left rail */}
      <div
        className="absolute left-5 top-1/2 hidden xl:block z-10"
        style={{ writingMode: "vertical-rl", transform: "translateY(-50%) rotate(180deg)" }}
      >
        <span className="text-[10px] tracking-[0.3em] opacity-25" style={{ ...mono, color: "#6b7fa8" }}>
          BUILDING WITH AI, THINKING WITH STORIES
        </span>
      </div>

      {/* ── Text content — left-aligned, bottom-anchored ── */}
      <div className="relative z-10 w-full max-w-[1440px] mx-auto px-10 lg:px-20 xl:px-28">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="max-w-2xl flex flex-col gap-5"
        >
          {/* Status tag */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-[11px] tracking-widest" style={{ ...mono, color: "#8a99b8" }}>
              SOFTWARE ENGINEER / AI BUILDER / PRODUCT CREATOR
            </span>
            <span
              className="text-[11px] px-2.5 py-0.5 rounded"
              style={{ ...mono, background: "rgba(139,92,246,0.18)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.35)" }}
            >
              · 2026
            </span>
          </motion.div>

          {/* Main title */}
          <div className="flex flex-col leading-[0.92]">
            <motion.span
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.55, ease: "easeOut" }}
              className="font-black text-white"
              style={{ ...display, fontSize: "clamp(64px,9vw,112px)" }}
            >
              SHUTAO
            </motion.span>
            <motion.span
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35, duration: 0.55, ease: "easeOut" }}
              className="font-black"
              style={{
                ...display,
                fontSize: "clamp(64px,9vw,112px)",
                WebkitTextStroke: "1.5px rgba(255,255,255,0.22)",
                color: "transparent",
              }}
            >
              CREATIVE
            </motion.span>
            <motion.span
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.55, ease: "easeOut" }}
              className="font-black"
              style={{
                ...display,
                fontSize: "clamp(64px,9vw,112px)",
                color: "#a78bfa",
                textShadow: "0 0 48px rgba(139,92,246,0.7), 0 0 100px rgba(139,92,246,0.3)",
              }}
            >
              OS
            </motion.span>
          </div>

          {/* Tagline */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.55 }}
            className="text-base leading-relaxed max-w-sm"
            style={{ ...body, color: "#8a99b8" }}
          >
            Building thoughtful digital products with code, design and AI.
          </motion.p>

          {/* CTA buttons */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.85, duration: 0.5 }}
            className="flex flex-wrap gap-4 pt-1"
          >
            <button
              onClick={() => scrollTo("projects")}
              className="flex items-center gap-2 px-7 py-3 text-sm font-semibold tracking-widest rounded transition-all duration-300 hover:brightness-110"
              style={{
                ...mono,
                background: "linear-gradient(135deg,#8b5cf6,#7c3aed)",
                color: "#fff",
                boxShadow: "0 0 28px rgba(139,92,246,0.4)",
              }}
            >
              EXPLORE PROJECTS
            </button>
            <a
              href="/resume.pdf"
              download="ShuTao_Zheng_Resume.pdf"
              className="flex items-center gap-2 px-7 py-3 text-sm font-semibold tracking-widest rounded transition-all duration-300 hover:bg-violet-600/10"
              style={{
                ...mono,
                color: "#a78bfa",
                border: "1px solid rgba(139,92,246,0.45)",
                backdropFilter: "blur(8px)",
              }}
            >
              <Download size={14} />
              DOWNLOAD RESUME
            </a>
          </motion.div>

          {/* Scroll hint */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.15, duration: 0.5 }}
            className="flex items-center gap-2 pt-2"
          >
            <ArrowDown size={12} className="text-violet-500 animate-bounce" />
            <span className="text-[10px] tracking-[0.28em]" style={{ ...mono, color: "#3a4a68" }}>
              SCROLL TO BOOT SYSTEM
            </span>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

// ─── PROFILE SECTION ─────────────────────────────────────────────────────────

function ProfileSection() {
  const [tab, setTab] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.2 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const tabContent = [
    {
      bio: "Backend-focused Full-Stack Software Engineer with 3+ years of hands-on experience building and maintaining enterprise SaaS, calendar synchronization systems, and production web platforms. Experienced in designing PostgreSQL-backed systems, developing scalable REST APIs, and remediating security vulnerabilities including SQL injection and privilege escalation. Comfortable owning systems end to end—from requirements gathering and schema design through implementation, testing, and deployment—and translating ambiguous business needs into reliable, maintainable solutions.",
      extras: (
        <div className="grid grid-cols-2 gap-3 mt-4">
          {[["SPECIALTY","Full-Stack / Mobile"],["LOCATION","Toronto, Canada"],["STATUS","Open to Work"],["FOCUS","Scalable Web Apps"]].map(([k,v])=>(
            <div key={k} style={{ border:"1px solid rgba(139,92,246,0.15)", borderRadius: 4, padding: "8px 10px" }}>
              <div className="text-[9px] tracking-widest mb-1" style={{ ...mono, color: "#4a5568" }}>{k}</div>
              <div className="text-xs" style={{ ...body, color: "#c4cde0" }}>{v}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      bio: "I approach engineering with security and correctness first — validating edge cases and data integrity before calling anything done. I like owning systems end to end, from requirements and schema design through implementation, testing, and deployment, not just the code in between. That said, I stay pragmatic: ship a working solution, then iterate, rather than over-engineering upfront. And since most hard problems are really communication problems, I care about turning ambiguous requirements into clear plans and supporting the engineers around me.",
      extras: (
        <div className="flex flex-wrap gap-2 mt-4">
          {["Security-first","End-to-end ownership","Ship fast, iterate","Data integrity","Mentorship","Clear communication"].map(v=>(
            <span key={v} className="text-[10px] px-3 py-1 rounded-full" style={{ ...mono, background:"rgba(139,92,246,0.12)", color:"#a78bfa", border:"1px solid rgba(139,92,246,0.25)" }}>{v}</span>
          ))}
        </div>
      ),
    },
    {
      bio: "Outside of work, I'm usually gaming — I keep a running backlog and enjoy digging into systems-heavy titles almost as much as playing them. I also make time to stay active, whether that's the gym or just getting outside. It's a good counterbalance to a day spent debugging: one is about solving problems, the other is about switching my brain off completely.",
      extras: (
        <div className="flex flex-wrap gap-2 mt-4">
          {["Gaming","Fitness","Console Gaming","Weightlifting","Game Backlog","Staying Active"].map(v=>(
            <span key={v} className="text-[10px] px-3 py-1 rounded-full" style={{ ...mono, background:"rgba(96,165,250,0.1)", color:"#93c5fd", border:"1px solid rgba(96,165,250,0.2)" }}>{v}</span>
          ))}
        </div>
      ),
    },
  ];

  return (
    <section
      ref={ref}
      id="profile"
      data-section="profile"
      className="relative min-h-screen flex items-center justify-center py-24"
    >
      {/* Blurred bg image */}
      <div className="absolute inset-0 overflow-hidden">
        <img
          src="https://images.unsplash.com/photo-1518770660439-4636190af475?w=1440&h=900&fit=crop&auto=format&q=60"
          alt=""
          className="w-full h-full object-cover opacity-10"
          style={{ filter: "blur(12px) saturate(0.5)" }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={visible ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7 }}
        className="relative z-10 w-full max-w-2xl mx-auto px-6"
      >
        {/* ID card */}
        <div
          className="rounded-xl overflow-hidden"
          style={{
            background: "rgba(10,14,28,0.82)",
            backdropFilter: "blur(32px)",
            border: "1px solid rgba(139,92,246,0.3)",
            boxShadow: "0 0 60px rgba(139,92,246,0.12), inset 0 1px 0 rgba(255,255,255,0.05)",
            transform: "perspective(900px) rotateY(-2deg) rotateX(1deg)",
          }}
        >
          {/* Card header strip */}
          <div className="flex items-center justify-between px-6 py-3" style={{ background: "rgba(139,92,246,0.12)", borderBottom: "1px solid rgba(139,92,246,0.2)" }}>
            <span className="text-[10px] tracking-widest" style={{ ...mono, color: "#6b7fa8" }}>CHARACTER PROFILE · SYS/ID-2026</span>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse inline-block" />
              <span className="text-[10px]" style={{ ...mono, color: "#a78bfa" }}>ACTIVE</span>
            </div>
          </div>

          <div className="p-6">
            {/* Avatar + name row */}
            <div className="flex gap-5 items-start mb-6">
              <div className="relative flex-shrink-0">
                <div className="w-24 h-24 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(139,92,246,0.4)" }}>
                  <img
                    src={avatarImg}
                    alt="Shutao avatar"
                    className="w-full h-full object-cover"
                  />
                </div>
                <span
                  className="absolute -bottom-2 -right-2 text-[8px] px-2 py-0.5 rounded"
                  style={{ ...mono, background: "#22c55e", color: "#000" }}
                >
                  ONLINE
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] tracking-widest mb-1" style={{ ...mono, color: "#4a5568" }}>DESIGNATION</div>
                <div className="text-2xl font-black text-white mb-0.5" style={display}>SHUTAO</div>
                <div className="text-sm mb-2" style={{ ...body, color: "#a78bfa" }}>Software Engineer · Full Stack Engineer</div>
                <div className="flex items-center gap-1 text-xs" style={{ ...mono, color: "#6b7fa8" }}>
                  <MapPin size={11} />
                  Toronto, CA
                </div>
              </div>
              {/* Stats */}
              <div className="hidden sm:flex flex-col gap-2 text-right">
                {[["EXP","4 YRS"],["EDU","B.MATH"],["CLASS","BUILDER"]].map(([l,v])=>(
                  <div key={l}>
                    <div className="text-[8px] tracking-widest" style={{ ...mono, color: "#4a5568" }}>{l}</div>
                    <div className="text-sm font-bold" style={{ ...mono, color: "#a78bfa" }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-5" style={{ borderBottom: "1px solid rgba(139,92,246,0.15)" }}>
              {PROFILE_TABS.map((t, i) => (
                <button
                  key={t}
                  onClick={() => setTab(i)}
                  className="pb-2.5 px-3 text-[11px] font-medium tracking-wide transition-colors relative"
                  style={{ ...mono, color: tab === i ? "#a78bfa" : "#4a5568" }}
                >
                  {t}
                  {tab === i && (
                    <motion.div
                      layoutId="tabline"
                      className="absolute bottom-0 left-0 right-0 h-px"
                      style={{ background: "#8b5cf6" }}
                    />
                  )}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                <p className="text-sm leading-relaxed" style={{ ...body, color: "#8a99b8" }}>
                  {tabContent[tab].bio}
                </p>
                {tabContent[tab].extras}
              </motion.div>
            </AnimatePresence>

            {/* Social row + barcode */}
            <div className="flex items-center justify-between mt-6 pt-5" style={{ borderTop: "1px solid rgba(139,92,246,0.12)" }}>
              <div className="flex gap-3">
                {[
                  { Icon: Github, label: "GitHub" },
                  { Icon: Linkedin, label: "LinkedIn" },
                  { Icon: Mail, label: "Email" },
                ].map(({ Icon, label }) => (
                  <button
                    key={label}
                    title={label}
                    className="p-2 rounded transition-all hover:bg-violet-600/20"
                    style={{ border: "1px solid rgba(139,92,246,0.2)", color: "#6b7fa8" }}
                  >
                    <Icon size={14} />
                  </button>
                ))}
              </div>
              <div className="flex flex-col items-end gap-1">
                {/* Stylized barcode */}
                <div className="flex gap-px h-6">
                  {Array.from({ length: 28 }, (_, i) => (
                    <div
                      key={i}
                      style={{
                        width: i % 3 === 0 ? 2 : 1,
                        background: "#8b5cf6",
                        opacity: 0.3 + (i % 5) * 0.14,
                      }}
                    />
                  ))}
                </div>
                <span className="text-[8px] tracking-widest" style={{ ...mono, color: "#4a5568" }}>ST-2026-0001</span>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// ─── JOURNEY SECTION ─────────────────────────────────────────────────────────

function JourneySection() {
  const [hovered, setHovered] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} id="journey" data-section="journey" className="relative py-24 px-6 lg:px-16">
      <div className="max-w-[960px] mx-auto">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="mb-14"
        >
          <h2 className="font-black text-white leading-none" style={{ ...display, fontSize: "clamp(52px,8vw,96px)" }}>
            JOURNEY
          </h2>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-4xl font-black" style={{ ...display, color: "#8b5cf6" }}>履历_</span>
            <div className="h-px flex-1 max-w-xs" style={{ background: "linear-gradient(to right,rgba(139,92,246,0.5),transparent)" }} />
          </div>
        </motion.div>

        {/* ── Work Experience ───────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ delay: 0.1, duration: 0.5 }}
          className="text-[10px] tracking-[0.25em] mb-6"
          style={{ ...mono, color: "#4a5568" }}
        >
          WORK EXPERIENCE
        </motion.div>

        <div className="flex flex-col">
          {JOURNEY.map((item, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 12 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 0.12 * i, duration: 0.5 }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              className="flex gap-0 sm:gap-8 py-6 transition-all duration-300"
              style={{
                borderBottom: "1px solid rgba(139,92,246,0.12)",
                background: hovered === i ? "rgba(139,92,246,0.05)" : "transparent",
                paddingLeft: hovered === i ? 10 : 0,
                paddingRight: hovered === i ? 10 : 0,
                borderRadius: 8,
              }}
            >
              {/* Year + period column */}
              <div className="flex-shrink-0 w-28 sm:w-36 pt-0.5">
                <div
                  className="text-2xl sm:text-3xl font-black leading-none mb-1 transition-colors duration-300"
                  style={{ ...display, color: hovered === i ? "#a78bfa" : "#8b5cf6", opacity: hovered === i ? 1 : 0.7 }}
                >
                  {item.year}
                </div>
                <div className="text-[10px] leading-tight" style={{ ...mono, color: "#4a5568", whiteSpace: "pre-line" }}>
                  {item.period}
                </div>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center overflow-hidden bg-white"
                    style={{ boxShadow: "0 0 12px rgba(139,92,246,0.1)" }}
                  >
                    <img src={item.logo} alt={`${item.company} logo`} className="w-full h-full object-contain p-1" />
                  </div>
                  <div>
                    <div className="text-base font-semibold text-white mb-0.5" style={display}>{item.role}</div>
                    <div className="text-[11px] tracking-wide" style={{ ...mono, color: "#60a5fa" }}>{item.company}</div>
                  </div>
                </div>

                <ul className="space-y-2.5">
                  {item.bullets.map((b, j) => (
                    <li key={j} className="flex gap-3 text-sm leading-relaxed">
                      <span className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0" style={{ background: "#8b5cf6", minWidth: 4, minHeight: 4 }} />
                      <span style={{ ...body, color: "#8a99b8" }}>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          ))}
        </div>

        {/* ── Education ────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 0.55, duration: 0.55 }}
          className="mt-16"
        >
          <h2 className="font-black text-white leading-none" style={{ ...display, fontSize: "clamp(52px,8vw,96px)" }}>
            EDUCATION
          </h2>
          <div className="flex items-center gap-3 mt-2 mb-8">
            <span className="text-4xl font-black" style={{ ...display, color: "#8b5cf6" }}>学历_</span>
            <div className="h-px flex-1 max-w-xs" style={{ background: "linear-gradient(to right,rgba(139,92,246,0.5),transparent)" }} />
          </div>

          <div
            className="rounded-xl p-6 lg:p-8"
            style={{
              background: "rgba(10,14,28,0.7)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgba(139,92,246,0.2)",
              boxShadow: "0 0 40px rgba(139,92,246,0.06)",
            }}
          >
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
              <div className="flex items-start gap-4">
                {/* UW Logo badge */}
                <div
                  className="flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ boxShadow: "0 0 16px rgba(255,199,44,0.12)" }}
                >
                  <img src={uwSeal} alt="University of Waterloo seal" className="w-14 h-14 rounded-full" />
                </div>

                <div>
                  <div className="text-lg font-black text-white mb-1" style={display}>{EDUCATION.school}</div>
                  <div className="text-sm mb-1" style={{ ...body, color: "#a78bfa" }}>{EDUCATION.degree}</div>
                  <div className="text-[11px]" style={{ ...mono, color: "#6b7fa8" }}>{EDUCATION.major}</div>
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[10px] tracking-widest mb-1" style={{ ...mono, color: "#4a5568" }}>PERIOD</div>
                <div className="text-sm font-semibold" style={{ ...mono, color: "#e2e8f4" }}>{EDUCATION.period}</div>
                <div className="text-[10px] mt-1" style={{ ...mono, color: "#4a5568" }}>{EDUCATION.location}</div>
              </div>
            </div>

            <div className="h-px mb-5" style={{ background: "rgba(139,92,246,0.12)" }} />

            <div>
              <div className="text-[9px] tracking-[0.2em] mb-3" style={{ ...mono, color: "#4a5568" }}>RELEVANT COURSES</div>
              <div className="flex flex-wrap gap-2">
                {EDUCATION.courses.map(c => (
                  <span
                    key={c}
                    className="text-[10px] px-2.5 py-1 rounded-full"
                    style={{ ...mono, background: "rgba(139,92,246,0.1)", color: "#c4cde0", border: "1px solid rgba(139,92,246,0.18)" }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

      </div>
    </section>
  );
}

// ─── SKILLS SECTION ──────────────────────────────────────────────────────────

function SkillsSection() {
  const [hovered, setHovered] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const statusColor: Record<string, string> = {
    ACTIVE: "#22c55e", STABLE: "#60a5fa", ENHANCED: "#a78bfa",
  };

  return (
    <section ref={ref} id="skills" data-section="skills" className="relative py-24 px-6 lg:px-16">
      <div className="max-w-[1200px] mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="mb-14"
        >
          <h2 className="font-black text-white leading-none" style={{ ...display, fontSize: "clamp(52px,8vw,96px)" }}>
            SKILLS
          </h2>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-4xl font-black" style={{ ...display, color: "#8b5cf6" }}>技能_</span>
            <div className="h-px flex-1 max-w-xs" style={{ background: "linear-gradient(to right,rgba(139,92,246,0.5),transparent)" }} />
          </div>
          <div className="text-[11px] tracking-widest mt-3" style={{ ...mono, color: "#4a5568" }}>
            SYSTEM MODULE OVERVIEW · 5 ACTIVE CORES
          </div>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {SKILLS.map((skill, i) => (
            <motion.div
              key={skill.id}
              initial={{ opacity: 0, y: 20 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 0.08 * i, duration: 0.5 }}
              onMouseEnter={() => setHovered(skill.id)}
              onMouseLeave={() => setHovered(null)}
              className="rounded-lg p-5 transition-all duration-300"
              style={{
                background: "rgba(10,14,28,0.75)",
                backdropFilter: "blur(16px)",
                border: hovered === skill.id
                  ? "1px solid rgba(139,92,246,0.55)"
                  : "1px solid rgba(139,92,246,0.15)",
                boxShadow: hovered === skill.id ? "0 0 24px rgba(139,92,246,0.12)" : "none",
                transform: hovered === skill.id ? "translateY(-2px)" : "translateY(0)",
              }}
            >
              {/* Card header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <span className="text-[10px] font-medium" style={{ ...mono, color: "#4a5568" }}>{skill.id}</span>
                  <skill.Icon size={14} style={{ color: "#8b5cf6" }} />
                  <span className="text-xs font-bold tracking-widest" style={{ ...mono, color: "#e2e8f4" }}>{skill.label}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: statusColor[skill.status] }}
                  />
                  <span className="text-[9px]" style={{ ...mono, color: statusColor[skill.status] }}>{skill.status}</span>
                </div>
              </div>
              {/* Divider */}
              <div className="h-px mb-4" style={{ background: "rgba(139,92,246,0.12)" }} />
              {/* Tags */}
              <div className="flex flex-wrap gap-2">
                {skill.items.map(item => (
                  <span
                    key={item}
                    className="text-[10px] px-2.5 py-1 rounded-full"
                    style={{ ...mono, background: "rgba(139,92,246,0.1)", color: "#c4cde0", border: "1px solid rgba(139,92,246,0.18)" }}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}

          {/* Empty card — summary */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={visible ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="rounded-lg p-5 flex flex-col justify-between"
            style={{ background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.2)", borderStyle: "dashed" }}
          >
            <div>
              <div className="text-[10px] tracking-widest mb-2" style={{ ...mono, color: "#4a5568" }}>SYSTEM STATUS</div>
              <div className="text-2xl font-black text-white mb-1" style={display}>ALWAYS<br />LEARNING</div>
            </div>
            <div className="space-y-2 mt-4">
              {[["PROJECTS SHIPPED","10+"],["YEARS EXP.","4+"],["EDUCATION","B.MATH UW"]].map(([l,v])=>(
                <div key={l} className="flex items-center justify-between">
                  <span className="text-[9px]" style={{ ...mono, color: "#4a5568" }}>{l}</span>
                  <span className="text-xs font-bold" style={{ ...mono, color: "#a78bfa" }}>{v}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

// ─── PROJECTS SECTION ────────────────────────────────────────────────────────

function ProjectsSection() {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const prev = () => setActive(a => (a - 1 + PROJECTS.length) % PROJECTS.length);
  const next = () => setActive(a => (a + 1) % PROJECTS.length);
  const p = PROJECTS[active];

  return (
    <section ref={ref} id="projects" data-section="projects" className="relative py-24">
      <div className="max-w-[1200px] mx-auto px-6 lg:px-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="mb-12"
        >
          <h2 className="font-black text-white leading-none" style={{ ...display, fontSize: "clamp(52px,8vw,96px)" }}>
            PROJECTS
          </h2>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-4xl font-black" style={{ ...display, color: "#8b5cf6" }}>项目_</span>
            <div className="h-px flex-1 max-w-xs" style={{ background: "linear-gradient(to right,rgba(139,92,246,0.5),transparent)" }} />
          </div>
        </motion.div>

        {/* Film strip carousel */}
        <div className="relative">
          {/* Navigation counter */}
          <div className="flex items-center justify-between mb-6">
            <span className="text-[11px]" style={{ ...mono, color: "#4a5568" }}>
              {String(active + 1).padStart(2,"0")} / {String(PROJECTS.length).padStart(2,"0")}
            </span>
            <div className="flex gap-2">
              <button onClick={prev} className="p-2 rounded transition-all hover:bg-violet-600/20" style={{ border: "1px solid rgba(139,92,246,0.25)", color: "#a78bfa" }}>
                <ChevronLeft size={18} />
              </button>
              <button onClick={next} className="p-2 rounded transition-all hover:bg-violet-600/20" style={{ border: "1px solid rgba(139,92,246,0.25)", color: "#a78bfa" }}>
                <ChevronRight size={18} />
              </button>
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="grid lg:grid-cols-[1fr_1.2fr] gap-8 items-center"
            >
              {/* Left — info */}
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <span className="text-5xl font-black opacity-20" style={{ ...display, color: p.color }}>{p.id}</span>
                  <div className="h-px flex-1" style={{ background: `linear-gradient(to right,${p.color}40,transparent)` }} />
                </div>
                <div>
                  <h3 className="font-black text-white leading-tight mb-1" style={{ ...display, fontSize: "clamp(28px,4vw,52px)" }}>{p.name}</h3>
                  <span className="text-[11px] px-3 py-1 rounded-full" style={{ ...mono, background: `${p.color}18`, color: p.color, border: `1px solid ${p.color}30` }}>
                    {p.type}
                  </span>
                </div>
                <p className="text-sm leading-relaxed" style={{ ...body, color: "#8a99b8" }}>{p.desc}</p>
                {p.bullets && (
                  <ul className="space-y-2.5">
                    {p.bullets.map((b, j) => (
                      <li key={j} className="flex gap-3 text-sm leading-relaxed">
                        <span className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0" style={{ background: p.color, minWidth: 4, minHeight: 4 }} />
                        <span style={{ ...body, color: "#8a99b8" }}>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  {p.tech.map(t => (
                    <span key={t} className="text-[10px] px-2.5 py-1 rounded" style={{ ...mono, background: "rgba(139,92,246,0.08)", color: "#c4cde0", border: "1px solid rgba(139,92,246,0.18)" }}>
                      {t}
                    </span>
                  ))}
                </div>
                {p.link && (
                  <a
                    href={p.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="self-start flex items-center gap-2 px-5 py-2.5 text-xs font-semibold tracking-widest rounded transition-all hover:opacity-90"
                    style={{ ...mono, color: "#fff", background: `linear-gradient(135deg,${p.color},${p.color}aa)`, boxShadow: `0 0 20px ${p.color}30` }}
                  >
                    VIEW PROJECT <ExternalLink size={12} />
                  </a>
                )}
              </div>

              {/* Right — image in film frame */}
              <div className="relative">
                {/* Film border top/bottom */}
                <div className="flex gap-2 mb-2 px-4">
                  {Array.from({length:12},(_,i)=>(
                    <div key={i} className="flex-1 h-3 rounded-sm" style={{ background:"rgba(139,92,246,0.15)", border:"1px solid rgba(139,92,246,0.1)" }} />
                  ))}
                </div>
                <div
                  className="rounded-lg overflow-hidden relative"
                  style={{ border: "2px solid rgba(139,92,246,0.2)", boxShadow: `0 0 40px ${p.color}15` }}
                >
                  <img
                    src={p.img}
                    alt={p.name}
                    className="w-full h-56 lg:h-72 object-cover"
                    style={{ filter: "saturate(0.75) brightness(0.8)" }}
                  />
                  <div className="absolute inset-0" style={{ background: `linear-gradient(135deg,${p.color}20 0%,transparent 60%,rgba(0,0,0,0.4) 100%)` }} />
                  <div className="absolute top-3 left-3">
                    <span className="text-3xl font-black opacity-50" style={{ ...display, color: p.color }}>{p.id}</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-2 px-4">
                  {Array.from({length:12},(_,i)=>(
                    <div key={i} className="flex-1 h-3 rounded-sm" style={{ background:"rgba(139,92,246,0.15)", border:"1px solid rgba(139,92,246,0.1)" }} />
                  ))}
                </div>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Dot indicators */}
          <div className="flex justify-center gap-2 mt-8">
            {PROJECTS.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className="rounded-full transition-all duration-300"
                style={{
                  width: i === active ? 20 : 6,
                  height: 6,
                  background: i === active ? "#8b5cf6" : "rgba(139,92,246,0.25)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── CONTACT SECTION ─────────────────────────────────────────────────────────

function ContactSection() {
  const [form, setForm] = useState({ name: "", email: "", type: "", message: "" });
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { error: invokeError } = await supabase.functions.invoke("contact-form", { body: form });
    setSending(false);
    if (invokeError) {
      setError("Failed to send — please try again or email me directly.");
      return;
    }
    setSent(true);
    setTimeout(() => setSent(false), 4000);
    setForm({ name: "", email: "", type: "", message: "" });
  };

  const inputStyle = {
    background: "rgba(139,92,246,0.06)",
    border: "1px solid rgba(139,92,246,0.2)",
    borderRadius: 6,
    padding: "10px 14px",
    color: "#e2e8f4",
    fontSize: 13,
    fontFamily: "'Inter',sans-serif",
    width: "100%",
    outline: "none",
    transition: "border-color 0.2s",
  };

  return (
    <section ref={ref} id="contact" data-section="contact" className="relative py-24 px-6 lg:px-16 pb-28">
      <div className="max-w-[1200px] mx-auto">
        <div className="grid lg:grid-cols-[1fr_1.2fr] gap-16 items-start">
          {/* Left */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={visible ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
          >
            <h2 className="font-black text-white leading-none mb-4" style={{ ...display, fontSize: "clamp(40px,6vw,78px)", lineHeight: 1 }}>
              LET&apos;S BUILD<br />
              <span style={{ color: "#8b5cf6" }}>SOMETHING</span><br />
              MEANINGFUL
            </h2>
            <div className="flex items-center gap-3 mb-6">
              <span className="text-4xl font-black" style={{ ...display, color: "#8b5cf6" }}>联系_</span>
              <div className="h-px flex-1 max-w-xs" style={{ background: "linear-gradient(to right,rgba(139,92,246,0.5),transparent)" }} />
            </div>
            <p className="text-sm leading-relaxed mb-8" style={{ ...body, color: "#6b7fa8" }}>
              Have a project in mind, want to collaborate, or just want to talk about AI and software? My inbox is always open.
            </p>
            <div className="space-y-3">
              {[
                { Icon: Mail, label: "EMAIL", value: "stzheng@uwaterloo.ca", href: "mailto:stzheng@uwaterloo.ca" },
                { Icon: Linkedin, label: "LINKEDIN", value: "/in/stzheng", href: "https://www.linkedin.com/in/stzheng/" },
                { Icon: Github, label: "GITHUB", value: "github.com/zhengshutao", href: "https://github.com/zhengshutao" },
              ].map(({ Icon, label, value, href }) => (
                <a key={label} href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-violet-600/10" style={{ border: "1px solid rgba(139,92,246,0.12)" }}>
                  <Icon size={16} style={{ color: "#8b5cf6", flexShrink: 0 }} />
                  <div>
                    <div className="text-[9px] tracking-widest" style={{ ...mono, color: "#4a5568" }}>{label}</div>
                    <div className="text-sm" style={{ ...body, color: "#c4cde0" }}>{value}</div>
                  </div>
                </a>
              ))}
            </div>
          </motion.div>

          {/* Right — form */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={visible ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="rounded-xl p-6 lg:p-8"
            style={{ background: "rgba(10,14,28,0.75)", backdropFilter: "blur(24px)", border: "1px solid rgba(139,92,246,0.2)" }}
          >
            {/* Terminal header */}
            <div className="flex items-center gap-2 mb-6 pb-4" style={{ borderBottom: "1px solid rgba(139,92,246,0.12)" }}>
              <Terminal size={14} style={{ color: "#8b5cf6" }} />
              <span className="text-[11px] tracking-widest" style={{ ...mono, color: "#6b7fa8" }}>TRANSMISSION PROTOCOL · ACTIVE</span>
            </div>

            <AnimatePresence mode="wait">
              {sent ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center py-16 gap-4"
                >
                  <Zap size={32} style={{ color: "#22c55e" }} />
                  <div className="text-sm font-bold tracking-widest" style={{ ...mono, color: "#22c55e" }}>
                    MESSAGE TRANSMITTED SUCCESSFULLY
                  </div>
                  <div className="text-xs" style={{ ...mono, color: "#4a5568" }}>
                    Expected response: within 24 hours
                  </div>
                </motion.div>
              ) : (
                <motion.form key="form" onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>NAME</label>
                      <input
                        style={inputStyle}
                        placeholder="Your name"
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>EMAIL</label>
                      <input
                        type="email"
                        style={inputStyle}
                        placeholder="your@email.com"
                        value={form.email}
                        onChange={e => setForm({ ...form, email: e.target.value })}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>PROJECT TYPE</label>
                    <select
                      style={{ ...inputStyle }}
                      value={form.type}
                      onChange={e => setForm({ ...form, type: e.target.value })}
                    >
                      <option value="">Select type...</option>
                      {["Full-stack Web App","AI Product","Mobile App","Consulting","Other"].map(o=>(
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>MESSAGE</label>
                    <textarea
                      style={{ ...inputStyle, resize: "none" }}
                      rows={4}
                      placeholder="Tell me about your project..."
                      value={form.message}
                      onChange={e => setForm({ ...form, message: e.target.value })}
                      required
                    />
                  </div>
                  {error && (
                    <div className="text-xs" style={{ ...mono, color: "#f87171" }}>{error}</div>
                  )}
                  <button
                    type="submit"
                    disabled={sending}
                    className="w-full flex items-center justify-center gap-2.5 py-3 text-sm font-semibold tracking-widest rounded-lg transition-all duration-300 hover:opacity-90 disabled:opacity-50"
                    style={{
                      ...mono,
                      color: "#fff",
                      background: "transparent",
                      border: "1px solid #8b5cf6",
                      boxShadow: "0 0 20px rgba(139,92,246,0.25), inset 0 0 20px rgba(139,92,246,0.05)",
                    }}
                  >
                    <Send size={14} /> {sending ? "SENDING..." : "SEND MESSAGE"}
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

// ─── STATUS BAR ──────────────────────────────────────────────────────────────

function StatusBar() {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-between px-4 lg:px-8 h-10"
      style={{
        background: "rgba(6,10,20,0.92)",
        backdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(139,92,246,0.15)",
      }}
    >
      <div className="flex items-center gap-2 lg:gap-4">
        {/* Always show on mobile: first 2, desktop: all 4 */}
        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px]" style={{ ...mono, background:"rgba(139,92,246,0.12)", border:"1px solid rgba(139,92,246,0.25)", color:"#a78bfa" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
          SYSTEM ONLINE
        </span>
        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px]" style={{ ...mono, background:"rgba(34,197,94,0.1)", border:"1px solid rgba(34,197,94,0.25)", color:"#4ade80" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
          OPEN TO WORK
        </span>
        <span className="hidden md:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px]" style={{ ...mono, background:"rgba(139,92,246,0.12)", border:"1px solid rgba(139,92,246,0.25)", color:"#a78bfa" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
          AI ASSISTANT ACTIVE
        </span>
        <span className="hidden lg:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px]" style={{ ...mono, background:"rgba(249,115,22,0.1)", border:"1px solid rgba(249,115,22,0.25)", color:"#fb923c" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
          UPDATED 2026
        </span>
      </div>
      <div className="text-[9px]" style={{ ...mono, color: "#2a3a5c" }}>
        <span className="hidden sm:inline">© 2026 SHUTAO · </span>OS v2.0.26
      </div>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeSection, setActiveSection] = useState("home");
  const [soundOn, setSoundOn] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.getAttribute("data-section") ?? "home");
          }
        });
      },
      { threshold: 0.35, rootMargin: "-60px 0px -60px 0px" }
    );
    document.querySelectorAll("[data-section]").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }, []);

  return (
    <div
      className="min-h-screen relative overflow-x-hidden"
      style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}
    >
      {/* Global background decoration */}
      <GridOverlay />
      <ScanLines />
      <Vignette />

      {/* Fixed UI chrome */}
      <Navbar active={activeSection} scrollTo={scrollTo} soundOn={soundOn} setSoundOn={setSoundOn} />
      <StatusBar />

      {/* Page sections */}
      <main className="relative z-20">
        <HeroSection scrollTo={scrollTo} />
        <ProfileSection />
        <JourneySection />
        <SkillsSection />
        <ProjectsSection />
        <ContactSection />
      </main>
    </div>
  );
}

/**
 * Prisma seed — cadastro inicial controler-v4
 * Roda: pnpm prisma:seed
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ─── User admin (João Henrique) ─────────────────────────
  const joao = await prisma.user.upsert({
    where: { email: "joaogrigoli1@gmail.com" },
    update: { phone: "5565984665555", active: true, blocked: false },
    create: {
      name: "João Henrique Grigoli",
      email: "joaogrigoli1@gmail.com",
      phone: "5565984665555",
      role: "admin",
      active: true
    }
  });
  console.log(`✓ User: ${joao.name} (${joao.id})`);

  // ─── Projects ───────────────────────────────────────────
  const projects = [
    {
      slug: "controler",
      name: "Controler",
      icon: "🎛️",
      description: "Command Center NOC (este sistema)",
      coolifyUuids: ["hksw4kg8owgs0wwg0o8k4kk0"],
      prodUrl: "https://controler.net.br"
    },
    {
      slug: "myclinicsoft",
      name: "MyClinicSoft",
      icon: "🏥",
      description: "SaaS de gestão clínica",
      coolifyUuids: ["jckc0ccwssowwc0oocw80ogs"],
      prodUrl: "https://myclinicsoft.com.br",
      repoUrl: "https://github.com/jhgm/myclinicsoft"
    },
    {
      slug: "libertakidz",
      name: "LibertaKidz",
      icon: "🧒",
      description: "Plataforma de educação infantil",
      coolifyUuids: ["yow040wosgowks8o80gk88g4"],
      prodUrl: "https://libertakidz.com.br"
    },
    {
      slug: "manalista",
      name: "Manalista",
      icon: "📝",
      coolifyUuids: ["x4g4sgw48s4s84wg8kkggs8g"],
      prodUrl: "https://manalista.com.br"
    },
    {
      slug: "fisiomt-laudo",
      name: "FisioMT Laudo",
      icon: "📋",
      coolifyUuids: ["rc8gwc0c008008sg8c88gos0"],
      prodUrl: "https://laudo.fisiomt.com.br"
    },
    {
      slug: "fisiomt-painel",
      name: "FisioMT Painel",
      icon: "🎯",
      coolifyUuids: ["gc4088ks8cws48kskcksgsg8"],
      prodUrl: "https://painel.fisiomt.com.br"
    },
    {
      slug: "passaro-professor",
      name: "Pássaro Professor",
      icon: "🐦",
      coolifyUuids: ["v8so4ocgkkkk8ows48skggcg"],
      prodUrl: "https://passaroprofessor.com.br"
    },
    {
      slug: "mail-stack",
      name: "Mail Stack",
      icon: "📧",
      description: "Stalwart + Roundcube + Nextcloud",
      coolifyUuids: []
    },
    {
      slug: "xospam",
      name: "Xospam",
      icon: "🤖",
      description: "Stack IA (Ollama + Postgres + Redis + Admin)",
      coolifyUuids: []
    }
  ];

  for (const p of projects) {
    await prisma.project.upsert({
      where: { slug: p.slug },
      update: { ...p },
      create: { ...p, active: true }
    });
    console.log(`✓ Project: ${p.name}`);
  }

  // ─── APIs por projeto (com healthUrl quando disponível) ─
  const apisByProject: Record<string, Array<{ name: string; baseUrl: string; ssmKeyPath?: string; environment?: string; healthUrl?: string; docsUrl?: string }>> = {
    controler: [
      { name: "Cloudflare", baseUrl: "https://api.cloudflare.com", ssmKeyPath: "/cloudflare/token", healthUrl: "https://api.cloudflare.com/client/v4/", docsUrl: "https://developers.cloudflare.com/api" },
      { name: "Coolify", baseUrl: "http://10.0.6.1:8000", ssmKeyPath: "/controler/coolify_token", docsUrl: "https://coolify.io/docs" },
      { name: "Hostinger API", baseUrl: "https://developers.hostinger.com", ssmKeyPath: "/myclinicsoft/hostinger_api_token", healthUrl: "https://developers.hostinger.com", docsUrl: "https://developers.hostinger.com" }
    ],
    myclinicsoft: [
      { name: "Z-API (WhatsApp)", baseUrl: "https://api.z-api.io", ssmKeyPath: "/shared/zapi/token", healthUrl: "https://api.z-api.io", docsUrl: "https://developer.z-api.io" },
      { name: "WhatsApp Cloud (Meta)", baseUrl: "https://graph.facebook.com", ssmKeyPath: "/myclinicsoft/whatsapp/access_token", docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api" },
      { name: "Infobip (SMS)", baseUrl: "https://6zjrk8.api.infobip.com", ssmKeyPath: "/shared/infobip/api_key", docsUrl: "https://www.infobip.com/docs" },
      { name: "Google AI", baseUrl: "https://generativelanguage.googleapis.com", ssmKeyPath: "/myclinicsoft/google_ai_api_key", docsUrl: "https://ai.google.dev" },
      { name: "Voyage AI", baseUrl: "https://api.voyageai.com", ssmKeyPath: "/myclinicsoft/voyage_api_key" },
      { name: "Focus NFE", baseUrl: "https://api.focusnfe.com.br", ssmKeyPath: "/myclinicsoft/focusnfe/token_homologacao", environment: "homologacao", docsUrl: "https://focusnfe.com.br/doc" }
    ],
    libertakidz: [
      { name: "Stripe", baseUrl: "https://api.stripe.com", docsUrl: "https://stripe.com/docs/api" }
    ],
    manalista: [
      { name: "Stripe", baseUrl: "https://api.stripe.com", ssmKeyPath: "/manalista/stripe-secret-key", docsUrl: "https://stripe.com/docs/api" },
      { name: "Resend", baseUrl: "https://api.resend.com", ssmKeyPath: "/manalista/resend-api-key", docsUrl: "https://resend.com/docs" },
      { name: "Google OAuth", baseUrl: "https://accounts.google.com", ssmKeyPath: "/manalista/google-client-id" }
    ],
    "mail-stack": [
      { name: "Stalwart Admin", baseUrl: "https://nas.controler.net.br", ssmKeyPath: "/myclinicsoft/nas/password", docsUrl: "https://stalw.art/docs" }
    ],
    xospam: [
      { name: "Google OAuth", baseUrl: "https://accounts.google.com", ssmKeyPath: "/xospam/google/client_id" },
      { name: "Ollama local", baseUrl: "http://localhost:11434", healthUrl: "http://10.0.6.1:11434/" }
    ]
  };

  let totalApis = 0;
  for (const [slug, apis] of Object.entries(apisByProject)) {
    const project = await prisma.project.findUnique({ where: { slug } });
    if (!project) { console.log(`⚠ projeto ${slug} não existe, pulando APIs`); continue; }
    for (const api of apis) {
      const id = `${project.id}-${api.name.replace(/[\s()\/]/g, '-').toLowerCase()}`;
      await prisma.projectApi.upsert({
        where: { id },
        update: { ...api, projectId: project.id, environment: api.environment || "prod" },
        create: { id, ...api, projectId: project.id, environment: api.environment || "prod" }
      });
      totalApis++;
    }
    console.log(`✓ ${apis.length} APIs cadastradas para ${slug}`);
  }
  console.log(`Total APIs: ${totalApis}`);

  // ─── Alert rules padrão ─────────────────────────────────
  const rules = [
    { name: "CPU host > 85% por 5min", condition: { type: "host_cpu_above", threshold: 85, duration: "5m" }, severity: "warning", channels: ["whatsapp"] },
    { name: "RAM host > 90%", condition: { type: "host_mem_above", threshold: 90 }, severity: "warning", channels: ["whatsapp"] },
    { name: "Disco > 80%", condition: { type: "host_disk_above", threshold: 80 }, severity: "warning", channels: ["whatsapp"] },
    { name: "Container parado inesperadamente", condition: { type: "container_stopped" }, severity: "critical", channels: ["whatsapp", "sms"] },
    { name: "SSL expira em < 30 dias", condition: { type: "ssl_expiring", days: 30 }, severity: "warning", channels: ["whatsapp"] },
    { name: "Site retornando 5xx", condition: { type: "site_5xx" }, severity: "critical", channels: ["whatsapp", "sms"] },
    { name: "Deploy falhou", condition: { type: "deploy_failed" }, severity: "warning", channels: ["whatsapp"] },
    { name: "Falha de auth (5x em 5min)", condition: { type: "auth_failure_burst", count: 5, window: "5m" }, severity: "critical", channels: ["whatsapp", "sms"] }
  ];

  for (const r of rules) {
    const existing = await prisma.alertRule.findFirst({ where: { name: r.name } });
    if (!existing) {
      await prisma.alertRule.create({ data: r });
      console.log(`✓ Rule: ${r.name}`);
    }
  }

  console.log("\n🎉 Seed concluído.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'dsh-trajectory-persistence',
  description:
    'DeepSeek Harness (dsh) plugin: persist session trajectories to S3/OSS (JSONL) and OTel GenAI spans (OTLP).',
  base: '/dsh-trajectory-persistence/',
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Configuration', link: '/guide/configuration' },
      {
        text: 'npm',
        link: 'https://www.npmjs.com/package/dsh-trajectory-persistence',
      },
      {
        text: 'GitHub',
        link: 'https://github.com/aws-cnug-o11y/dsh-trajectory-persistence',
      },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration Reference', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Sinks',
        items: [
          { text: 'Ship & Sync', link: '/guide/ship-sync' },
          { text: 'S3 (push mode)', link: '/guide/s3-sink' },
          { text: 'OTel GenAI Sink', link: '/guide/otel-sink' },
          { text: 'AWS CloudWatch & AgentCore', link: '/guide/aws-cloudwatch' },
        ],
      },
      {
        text: 'Contributing',
        items: [{ text: 'Development', link: '/guide/development' }],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/aws-cnug-o11y/dsh-trajectory-persistence' },
    ],

    editLink: {
      pattern: 'https://github.com/aws-cnug-o11y/dsh-trajectory-persistence/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'dsh-trajectory-persistence contributors',
    },

    search: {
      provider: 'local',
    },
  },
})

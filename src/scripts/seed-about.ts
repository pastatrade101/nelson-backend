/**
 * Seed the About page content (the `about_*` rows of homepage_sections).
 *
 * Idempotent: upserts on section_key, so re-running updates the same rows and
 * never duplicates. Everything seeded here stays editable in the admin at
 * /admin/about — this script just puts the client-supplied copy in place.
 *
 *   npm run seed:about          (dev / tsx)
 *   npm run seed:about:prod     (built / node dist)
 */
import { supabase } from '../config/supabase';

type SectionSeed = {
  section_key: string;
  title?: string | null;
  subtitle?: string | null;
  content?: string | null;
  image_url?: string | null;
  button_text?: string | null;
  button_url?: string | null;
  extra_data?: Record<string, unknown>;
  sort_order: number;
};

const SECTIONS: SectionSeed[] = [
  {
    section_key: 'about_seo',
    sort_order: 0,
    extra_data: {
      meta_title: 'About Emnel Adventures — Private Tanzania Safaris from Arusha',
      meta_description:
        'Emnel Adventures is a family-founded, locally owned Tanzania safari company based in Arusha. Our story, our founding team of TANAPA-certified guides, and the community work behind every safari.'
    }
  },
  {
    section_key: 'about_hero',
    sort_order: 1,
    title: 'A Tanzanian family’s safari company, built in Arusha.',
    subtitle:
      'Maasai cattle herder turned celebrated chef whose forty-year career paid for his children’s education. Today, Nelson and the founding team run private safaris across Tanzania the way the country deserves to be experienced.',
    button_text: 'Plan Your Safari',
    button_url: '/plan-my-trip',
    image_url: '',
    extra_data: {
      eyebrow: 'PRIVATE TANZANIA SAFARIS · ARUSHA · EST. 2016',
      image_alt: 'Emnel Adventures — private safaris across Tanzania, operated from Arusha'
    }
  },
  {
    section_key: 'about_stats',
    sort_order: 2,
    title: 'At a Glance',
    extra_data: {
      stats: [
        { value: '9+ Years', label: 'in Tanzania' },
        { value: '100%', label: 'Private Vehicles' },
        { value: '5★', label: 'TripAdvisor' },
        { value: '24hrs', label: 'Response Time' }
      ]
    }
  },
  {
    section_key: 'about_founder',
    sort_order: 3,
    title: 'The Story Behind the Name',
    content: [
      '“Emnel” is two names joined: Emily, my youngest sister, and Nelson — me. The company carries my family inside it.',
      'But the story begins long before 2016, with my father, Anania Mesuli Laizer.',
      'He grew up herding cattle in Sekei, a Maasai village outside Arusha. Education was not in the script for the son of a herding family in his generation.',
      'He pushed his way into a kitchen anyway, then into a culinary apprenticeship, and eventually to Utalii College in Nairobi — the most respected hospitality training institution in East Africa at the time, and still today.',
      'By the time he finished, he had become one of the celebrated chefs of his generation.',
      'He cooked across hotels and lodges in Tanzania and Kenya for forty years. Every shilling he earned went back into educating his children.',
      'Mine was one of those educations.',
      'He’s still in Arusha.',
      'Emnel Adventures exists because of him.'
    ].join('\n\n'),
    button_text: 'Meet Our Team',
    button_url: '#team',
    image_url: '',
    extra_data: { image_caption: '' }
  },
  {
    section_key: 'about_beginning',
    sort_order: 4,
    title: 'How the Company Began',
    content: [
      'In 2016 I founded Emnel with $200 and a website I built myself.',
      'I taught myself Google Ads from YouTube videos. Most of the enquiries that came in went nowhere — I was learning, slowly, the difference between a curious email and a booking.',
      'Then came Cornelia — our first direct guest.',
      'She came during COVID, when no other traveller in Tanzania was moving. I built her itinerary with more care than perhaps any I’ve built since, because so much was riding on it.',
      'She loved her trip, left us a five-star TripAdvisor review, and went home and referred a friend.',
      'She also documented the trip on film. Her own words, no scripting from us.'
    ].join('\n\n'),
    extra_data: {
      video_url: '',
      video_caption: 'Tanzania Safari Experience',
      closing: [
        'That feeling — the pride of having looked after someone properly, and the trust that came back as a referral — is the feeling Emnel was built around.',
        'Nearly a decade in, it’s still the standard.'
      ].join('\n\n')
    }
  },
  {
    section_key: 'about_what_we_do',
    sort_order: 5,
    title: 'What Emnel Does Today',
    content: [
      'We create and operate private safari experiences across Tanzania, with a particular focus on the landscapes, wildlife and communities of northern Tanzania.',
      'Our safaris are designed and operated from Arusha by people who live here and know these places personally.',
      'We don’t believe a safari should feel like a package moving through a production line.',
      'Every journey is an opportunity to understand what our guests actually want from Tanzania and build the experience around them — whether that’s wildlife, photography, culture, family travel, a honeymoon, a first safari or simply the chance to experience the country at a slower pace.',
      'Our vehicles are private, our itineraries are thoughtfully planned, and our guides are at the heart of the experience.'
    ].join('\n\n')
  },
  {
    section_key: 'about_guides',
    sort_order: 6,
    subtitle: 'The Team',
    title: 'The people who bring Tanzania to life',
    content: [
      'Emnel is run by a small founding team of Tanzanian-born, TANAPA-certified guides — all based in Arusha and all part of the company since its early years.',
      'These are not simply people assigned to a booking.'
    ].join('\n\n'),
    button_text: 'Meet the Emnel Team',
    button_url: '', // no destination supplied — the button stays hidden until one is set
    extra_data: {
      guides: [
        { name: 'Rahim Maghimbi', title: 'Senior Guide · English Speaking', speciality: '', years: '', quote: '', author: '', image_url: '' },
        { name: 'Gabriel Sanguyan', title: 'Senior Guide · English Speaking', speciality: '', years: '', quote: '', author: '', image_url: '' },
        { name: 'Ally Msemo', title: 'Senior Guide · English Speaking', speciality: '', years: '', quote: '', author: '', image_url: '' },
        { name: 'Prince Charles', title: 'Safari Guide · German & English Speaking', speciality: '', years: '', quote: '', author: '', image_url: '' }
      ]
    }
  },
  {
    section_key: 'about_licences',
    sort_order: 7,
    title: 'Licences & Certifications',
    content: [
      'We believe trust should be backed by more than words.',
      'Emnel Adventures operates as a locally established Tanzanian safari company supported by professional guides and industry affiliations.'
    ].join('\n\n'),
    extra_data: {
      items: [
        'Licensed by the Ministry of Natural Resources',
        'Member of the Tanzania Local Tour Operators Association (TLTO)',
        'Guides certified by Tanzania National Parks Authority (TANAPA)',
        '5-star rated on TripAdvisor'
      ]
    }
  },
  {
    section_key: 'about_giving',
    sort_order: 8,
    title: 'Giving Back',
    subtitle: 'Our Partnership with Reepads Tanzania',
    content: [
      'The places our guests travel through are not simply destinations to us.',
      'They are home.',
      'That is why we believe tourism should contribute something meaningful to the communities around us.',
      'Emnel Adventures partners with Reepads Tanzania, a Tanzanian social enterprise producing locally made, reusable menstrual products and working with schools and communities to improve access to safe and sustainable menstrual care.',
      'Reepads combines menstrual products with education and community outreach, helping address both access to menstrual products and the stigma surrounding menstruation.'
    ].join('\n\n'),
    button_text: 'Learn More About Reepads Tanzania',
    button_url: '', // no URL supplied — the button stays hidden until one is set
    extra_data: {
      highlight: '1% of our net revenue. Locally led. Community focused. Every safari contributes.',
      blocks: [
        {
          title: 'Why This Work Matters',
          body: [
            'For girls in some rural and underserved communities, access to reliable menstrual products remains a challenge.',
            'That can affect much more than personal comfort.',
            'It can affect confidence, dignity and the ability to participate fully in school.',
            'Reepads works with schools, community organisations and local leaders to identify communities where support is needed.',
            'Their work doesn’t stop at distributing products.',
            'Educational programs cover menstrual hygiene, reproductive health, the correct use and care of reusable pads and conversations aimed at breaking the myths and stigma surrounding menstruation.',
            'The approach is deliberately community-focused so that solutions are built around local realities rather than imposed from outside.'
          ].join('\n\n')
        },
        {
          title: 'A Locally Made, Reusable Solution',
          body: [
            'Reepads produces reusable sanitary pads in Tanzania using absorbent and hygienic materials.',
            'Unlike disposable products that must continually be replaced, the reusable pads can be washed, cared for and used repeatedly over an extended period.',
            'This makes them particularly valuable in communities where buying disposable menstrual products every month can be difficult.',
            'The approach also reduces waste while supporting a Tanzanian, women-led enterprise.',
            'It is a solution that combines dignity, education, sustainability and local economic impact.'
          ].join('\n\n')
        },
        {
          title: 'Our Commitment',
          body: [
            '1% of Emnel Adventures’ net revenue supports this initiative.',
            'This is not an optional donation added at checkout.',
            'It is part of how we have chosen to operate our company.',
            'Reepads works directly with communities and schools to identify areas where menstrual products and education are needed, including villages and schools where access to these products can be limited.',
            'Our contribution helps sponsor a portion of the production, menstrual kits, education and distribution required to reach these communities.',
            'Where possible, members of the Emnel team also join Reepads during community and school distribution activities.',
            'Some of these communities are particularly meaningful to us — including areas around Arusha and the rural communities connected to where our families and guides grew up.',
            'Every safari therefore contributes, in a small but permanent way, to a locally led initiative.'
          ].join('\n\n')
        },
        {
          title: 'More Than Pads',
          body: [
            'We chose Reepads because the initiative goes beyond simply handing out menstrual products.',
            'Reepads works with schools, NGOs, community organisations and other partners to provide education around:'
          ].join('\n\n'),
          items: [
            'Menstrual health and hygiene',
            'Correct use and care of reusable pads',
            'Puberty and reproductive health',
            'Hygiene and WASH',
            'Breaking menstrual myths and stigma',
            'Community awareness and engagement'
          ]
        },
        {
          title: 'Our Guests Are Welcome to Participate',
          body: [
            'Their community model also involves educators, parents, health workers and community leaders where appropriate.',
            'That matters to us because lasting impact requires more than a one-day distribution.',
            'It requires knowledge, access and communities that can continue the conversation.',
            'We also want our guests to have the opportunity to understand the communities behind the landscapes they visit.',
            'Participation is completely voluntary.',
            'Guests interested in the Reepads initiative can learn more about the work, make an additional contribution if they wish, or — when timing, location and community arrangements make it appropriate — participate alongside us in a community activity or distribution.',
            'There is no expectation to participate and no pressure to donate.',
            'Your safari already contributes through Emnel’s 1% commitment.',
            'For guests who want to become more involved, however, we are happy to create that connection.'
          ].join('\n\n')
        }
      ]
    }
  },
  {
    section_key: 'about_closing',
    sort_order: 9,
    title: 'Tourism That Stays Connected to Home',
    content: [
      'Emnel started with family.',
      'It started with a Maasai cattle herder from Sekei who found his way into a kitchen, built a forty-year career and used what he earned to educate his children.',
      'One of those children eventually started a safari company with $200.',
      'That history shapes how we think about tourism today.',
      'We want to build an exceptional safari company.',
      'But we also want the success of that company to remain connected to the people and communities that made it possible.',
      'Our partnership with Reepads is one small way of doing that.'
    ].join('\n\n')
  },
  {
    section_key: 'about_cta',
    sort_order: 10,
    title: 'Travel With People Who Call Tanzania Home',
    subtitle:
      'Your safari shouldn’t just show you Tanzania. It should connect you with the people who know it, live it and care about what happens here after you leave.',
    button_text: 'Plan Your Safari',
    button_url: '/plan-my-trip',
    extra_data: { footnote: 'Private journeys. Local guides. Tanzania, from the people who call it home.' }
  }
];

const run = async () => {
  const payload = SECTIONS.map((s) => ({
    section_key: s.section_key,
    title: s.title ?? null,
    subtitle: s.subtitle ?? null,
    content: s.content ?? null,
    image_url: s.image_url ?? null,
    button_text: s.button_text ?? null,
    button_url: s.button_url ?? null,
    extra_data: s.extra_data ?? {},
    is_active: true,
    sort_order: s.sort_order
  }));

  const { data, error } = await supabase
    .from('homepage_sections')
    .upsert(payload, { onConflict: 'section_key' })
    .select('section_key');

  if (error) {
    console.error('✗ Seed failed:', error.message);
    process.exit(1);
  }

  console.log(`✓ Seeded ${data?.length ?? 0} About sections:`);
  for (const row of data ?? []) console.log(`   · ${(row as { section_key: string }).section_key}`);
  console.log('\nEdit any of it at /admin/about.');
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

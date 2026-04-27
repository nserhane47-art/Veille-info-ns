// ============================================================
// VEILLE PRO - Serveur Backend
// Ce serveur récupère les données réelles : RSS, Google Trends,
// Reddit, Hacker News, YouTube
// ============================================================

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const googleTrends = require('google-trends-api');
const fetch = require('node-fetch');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'VeillePro/1.0 (Educational tool)'
  }
});

// Permet à n'importe quel site (votre dashboard) d'appeler ce serveur
app.use(cors());
app.use(express.json());

// ============================================================
// SOURCES RSS PRÉ-CONFIGURÉES (médias français de qualité)
// ============================================================
const SOURCES_RSS = {
  // Économie & business généralistes
  lemonde_eco:    { nom: 'Le Monde Éco',      url: 'https://www.lemonde.fr/economie/rss_full.xml' },
  lesechos:       { nom: 'Les Échos',          url: 'https://services.lesechos.fr/rss/les-echos-economie.xml' },
  lefigaro_eco:   { nom: 'Le Figaro Éco',      url: 'https://www.lefigaro.fr/rss/figaro_economie.xml' },
  bfm_business:   { nom: 'BFM Business',       url: 'https://www.bfmtv.com/rss/economie/' },
  challenges:     { nom: 'Challenges',         url: 'https://www.challenges.fr/rss.xml' },
  capital:        { nom: 'Capital',            url: 'https://www.capital.fr/rss' },

  // Marketing, retail, conso
  lsa:            { nom: 'LSA Conso',          url: 'https://www.lsa-conso.fr/rss' },
  strategies:     { nom: 'Stratégies',         url: 'https://www.strategies.fr/rss.xml' },
  ecommercemag:   { nom: 'E-commerce Mag',     url: 'https://www.ecommercemag.fr/rss/' },

  // Tech & digital
  frenchweb:      { nom: 'FrenchWeb',          url: 'https://www.frenchweb.fr/feed' },
  journaldunet:   { nom: 'Journal du Net',     url: 'https://www.journaldunet.com/rss/' },
  usine_digitale: { nom: 'Usine Digitale',     url: 'https://www.usine-digitale.fr/rss' },

  // Industrie & B2B
  usinenouvelle:  { nom: 'Usine Nouvelle',     url: 'https://www.usinenouvelle.com/rss' },

  // International
  reuters_biz:    { nom: 'Reuters Business',   url: 'https://feeds.reuters.com/reuters/businessNews' },
  ft:             { nom: 'Financial Times',    url: 'https://www.ft.com/rss/home' }
};

// ============================================================
// ROUTE 1 : Liste des sources disponibles
// ============================================================
app.get('/api/sources', (req, res) => {
  const liste = Object.entries(SOURCES_RSS).map(([id, s]) => ({
    id,
    nom: s.nom
  }));
  res.json(liste);
});

// ============================================================
// ROUTE 2 : Récupérer un flux RSS pré-configuré
// ============================================================
app.get('/api/rss/:sourceId', async (req, res) => {
  try {
    const source = SOURCES_RSS[req.params.sourceId];
    if (!source) return res.status(404).json({ erreur: 'Source inconnue' });

    const feed = await parser.parseURL(source.url);
    const articles = feed.items.slice(0, 20).map(item => ({
      titre: item.title,
      lien: item.link,
      date: item.pubDate || item.isoDate,
      description: nettoyerHTML(item.contentSnippet || item.content || ''),
      source: source.nom
    }));

    res.json({ source: source.nom, articles });
  } catch (e) {
    console.error('Erreur RSS:', e.message);
    res.status(500).json({ erreur: 'Impossible de charger le flux', detail: e.message });
  }
});

// ============================================================
// ROUTE 3 : Récupérer un flux RSS personnalisé (Google Alerts ou autre)
// ============================================================
app.post('/api/rss-custom', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ erreur: 'URL invalide' });
    }

    const feed = await parser.parseURL(url);
    const articles = feed.items.slice(0, 20).map(item => ({
      titre: item.title,
      lien: item.link,
      date: item.pubDate || item.isoDate,
      description: nettoyerHTML(item.contentSnippet || item.content || ''),
      source: feed.title || 'Flux personnalisé'
    }));

    res.json({ source: feed.title || 'Flux personnalisé', articles });
  } catch (e) {
    console.error('Erreur RSS custom:', e.message);
    res.status(500).json({ erreur: 'Impossible de charger ce flux RSS', detail: e.message });
  }
});

// ============================================================
// ROUTE 4 : Recherche par mot-clé dans plusieurs sources
// ============================================================
app.post('/api/recherche', async (req, res) => {
  try {
    const { motcle, sources } = req.body;
    if (!motcle) return res.status(400).json({ erreur: 'Mot-clé manquant' });

    const sourcesACharger = sources && sources.length
      ? sources
      : Object.keys(SOURCES_RSS).slice(0, 8);

    const resultats = await Promise.allSettled(
      sourcesACharger.map(async id => {
        const source = SOURCES_RSS[id];
        if (!source) return null;
        const feed = await parser.parseURL(source.url);
        return feed.items
          .filter(item => {
            const texte = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
            return texte.includes(motcle.toLowerCase());
          })
          .slice(0, 5)
          .map(item => ({
            titre: item.title,
            lien: item.link,
            date: item.pubDate || item.isoDate,
            description: nettoyerHTML(item.contentSnippet || ''),
            source: source.nom
          }));
      })
    );

    const articles = resultats
      .filter(r => r.status === 'fulfilled' && r.value)
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ motcle, total: articles.length, articles });
  } catch (e) {
    console.error('Erreur recherche:', e.message);
    res.status(500).json({ erreur: e.message });
  }
});

// ============================================================
// ROUTE 5 : Google Trends - évolution sur 30 jours
// ============================================================
app.get('/api/trends/timeline/:motcle', async (req, res) => {
  try {
    const motcle = req.params.motcle;
    const data = await googleTrends.interestOverTime({
      keyword: motcle,
      startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      geo: 'FR'
    });
    const parsed = JSON.parse(data);
    const points = parsed.default.timelineData.map(p => ({
      date: p.formattedAxisTime,
      valeur: p.value[0]
    }));
    res.json({ motcle, points });
  } catch (e) {
    console.error('Erreur Trends:', e.message);
    res.status(500).json({ erreur: 'Google Trends indisponible', detail: e.message });
  }
});

// ============================================================
// ROUTE 6 : Google Trends - comparaison de mots-clés
// ============================================================
app.post('/api/trends/compare', async (req, res) => {
  try {
    const { motscles } = req.body;
    if (!motscles || !motscles.length) {
      return res.status(400).json({ erreur: 'Mots-clés manquants' });
    }
    const motsLimites = motscles.slice(0, 5);
    const data = await googleTrends.interestOverTime({
      keyword: motsLimites,
      startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      geo: 'FR'
    });
    const parsed = JSON.parse(data);
    const points = parsed.default.timelineData.map(p => {
      const ligne = { date: p.formattedAxisTime };
      motsLimites.forEach((mc, i) => {
        ligne[mc] = p.value[i];
      });
      return ligne;
    });
    res.json({ motscles: motsLimites, points });
  } catch (e) {
    console.error('Erreur Trends compare:', e.message);
    res.status(500).json({ erreur: 'Google Trends indisponible', detail: e.message });
  }
});

// ============================================================
// ROUTE 7 : Google Trends - répartition régionale
// ============================================================
app.get('/api/trends/regions/:motcle', async (req, res) => {
  try {
    const motcle = req.params.motcle;
    const data = await googleTrends.interestByRegion({
      keyword: motcle,
      startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      geo: 'FR',
      resolution: 'REGION'
    });
    const parsed = JSON.parse(data);
    const regions = parsed.default.geoMapData
      .filter(r => r.value[0] > 0)
      .sort((a, b) => b.value[0] - a.value[0])
      .slice(0, 10)
      .map(r => ({
        region: r.geoName,
        valeur: r.value[0]
      }));
    res.json({ motcle, regions });
  } catch (e) {
    console.error('Erreur Trends regions:', e.message);
    res.status(500).json({ erreur: 'Google Trends indisponible', detail: e.message });
  }
});

// ============================================================
// ROUTE 8 : Reddit - posts par mot-clé
// ============================================================
app.get('/api/reddit/:motcle', async (req, res) => {
  try {
    const motcle = encodeURIComponent(req.params.motcle);
    const url = `https://www.reddit.com/search.json?q=${motcle}&sort=new&limit=15`;
    const reponse = await fetch(url, {
      headers: { 'User-Agent': 'VeillePro/1.0' }
    });
    const data = await reponse.json();
    const posts = (data.data?.children || []).map(p => ({
      titre: p.data.title,
      auteur: 'r/' + p.data.subreddit,
      texte: (p.data.selftext || '').slice(0, 200),
      score: p.data.score,
      commentaires: p.data.num_comments,
      lien: 'https://reddit.com' + p.data.permalink,
      date: new Date(p.data.created_utc * 1000).toISOString()
    }));
    res.json({ motcle: req.params.motcle, posts });
  } catch (e) {
    console.error('Erreur Reddit:', e.message);
    res.status(500).json({ erreur: 'Reddit indisponible', detail: e.message });
  }
});

// ============================================================
// ROUTE 9 : Hacker News - articles par mot-clé
// ============================================================
app.get('/api/hackernews/:motcle', async (req, res) => {
  try {
    const motcle = encodeURIComponent(req.params.motcle);
    const url = `https://hn.algolia.com/api/v1/search?query=${motcle}&tags=story&hitsPerPage=15`;
    const reponse = await fetch(url);
    const data = await reponse.json();
    const articles = (data.hits || []).map(h => ({
      titre: h.title,
      lien: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      auteur: h.author,
      points: h.points,
      commentaires: h.num_comments,
      date: h.created_at
    }));
    res.json({ motcle: req.params.motcle, articles });
  } catch (e) {
    console.error('Erreur HN:', e.message);
    res.status(500).json({ erreur: 'Hacker News indisponible', detail: e.message });
  }
});

// ============================================================
// ROUTE 10 : YouTube - chaîne par identifiant
// (chaque chaîne YouTube a un flux RSS public)
// ============================================================
app.get('/api/youtube/:channelId', async (req, res) => {
  try {
    const id = req.params.channelId;
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
    const feed = await parser.parseURL(url);
    const videos = feed.items.slice(0, 10).map(v => ({
      titre: v.title,
      lien: v.link,
      auteur: feed.title,
      date: v.pubDate || v.isoDate
    }));
    res.json({ chaine: feed.title, videos });
  } catch (e) {
    console.error('Erreur YouTube:', e.message);
    res.status(500).json({ erreur: 'Chaîne YouTube introuvable', detail: e.message });
  }
});

// ============================================================
// ROUTE TEST
// ============================================================
app.get('/', (req, res) => {
  res.json({
    nom: 'VEILLE PRO API',
    version: '1.0.0',
    statut: 'OK',
    endpoints: [
      'GET  /api/sources',
      'GET  /api/rss/:sourceId',
      'POST /api/rss-custom',
      'POST /api/recherche',
      'GET  /api/trends/timeline/:motcle',
      'POST /api/trends/compare',
      'GET  /api/trends/regions/:motcle',
      'GET  /api/reddit/:motcle',
      'GET  /api/hackernews/:motcle',
      'GET  /api/youtube/:channelId'
    ]
  });
});

// ============================================================
// FONCTION UTILITAIRE
// ============================================================
function nettoyerHTML(texte) {
  if (!texte) return '';
  return texte
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
    .slice(0, 300);
}

// ============================================================
// DÉMARRAGE
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ VEILLE PRO API démarrée sur le port ${PORT}`);
});

module.exports = app;

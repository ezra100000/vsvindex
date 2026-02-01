const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const LEAGUES = [
  {
    id: 'premier-league',
    name: 'Premier League',
    url: 'https://www.livesport.cz/fotbal/anglie/premier-league/vysledky/'
  },
  {
    id: 'ligue-1',
    name: 'Ligue 1',
    url: 'https://www.livesport.cz/fotbal/francie/ligue-1/vysledky/'
  },
  {
    id: 'serie-a',
    name: 'Serie A',
    url: 'https://www.livesport.cz/fotbal/italie/serie-a/vysledky/'
  },
  {
    id: 'bundesliga',
    name: 'Bundesliga',
    url: 'https://www.livesport.cz/fotbal/nemecko/bundesliga/vysledky/'
  },
  {
    id: 'laliga',
    name: 'La Liga',
    url: 'https://www.livesport.cz/fotbal/spanelsko/laliga/vysledky/'
  }
];

async function scrapeLeagueMatches(page, league) {
  console.log(`Scraping ${league.name}...`);
  
  try {
    await page.goto(league.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);

    const matches = await page.evaluate(() => {
      const matchData = [];
      const rounds = document.querySelectorAll('.sportName.soccer');
      
      let roundCount = 0;
      for (let round of rounds) {
        if (roundCount >= 5) break;
        
        let currentElement = round.nextElementSibling;
        while (currentElement && !currentElement.classList.contains('sportName')) {
          if (currentElement.classList.contains('event__match')) {
            const homeTeam = currentElement.querySelector('.event__participant--home')?.textContent.trim();
            const awayTeam = currentElement.querySelector('.event__participant--away')?.textContent.trim();
            const scoreHome = currentElement.querySelector('.event__score--home')?.textContent.trim();
            const scoreAway = currentElement.querySelector('.event__score--away')?.textContent.trim();
            const matchId = currentElement.getAttribute('id')?.replace('g_1_', '');
            
            if (homeTeam && awayTeam && scoreHome && scoreAway && matchId) {
              matchData.push({
                homeTeam,
                awayTeam,
                scoreHome: parseInt(scoreHome),
                scoreAway: parseInt(scoreAway),
                matchId
              });
            }
          }
          currentElement = currentElement.nextElementSibling;
        }
        roundCount++;
      }
      
      return matchData;
    });

    console.log(`Found ${matches.length} matches for ${league.name}`);

    for (let match of matches) {
      try {
        const oddsUrl = `https://www.livesport.cz/zapas/${match.matchId}/kurzy/draw-no-bet/zakladni-doba/`;
        await page.goto(oddsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        const odds = await page.evaluate(() => {
          const oddsElements = document.querySelectorAll('.ui-table__row');
          let homeOdds = null;
          let awayOdds = null;

          for (let row of oddsElements) {
            const cells = row.querySelectorAll('.ui-table__cell');
            if (cells.length >= 3) {
              const label = cells[0]?.textContent.trim();
              if (label === '1' && !homeOdds) {
                homeOdds = parseFloat(cells[1]?.textContent.trim());
              }
              if (label === '2' && !awayOdds) {
                awayOdds = parseFloat(cells[1]?.textContent.trim());
              }
            }
          }

          return { homeOdds, awayOdds };
        });

        match.homeOdds = odds.homeOdds;
        match.awayOdds = odds.awayOdds;
      } catch (error) {
        console.error(`Error getting odds for match ${match.matchId}:`, error.message);
      }
    }

    return matches;
  } catch (error) {
    console.error(`Error scraping ${league.name}:`, error.message);
    return [];
  }
}

function calculateVSV(teamMatches) {
  let totalStakes = 0;
  let totalReturns = 0;
  let favoriteCount = 0;
  let outsiderCount = 0;

  for (let match of teamMatches) {
    if (!match.teamOdds || !match.opponentOdds || match.isDraw) continue;

    const isFavorite = match.teamOdds < match.opponentOdds;
    const stake = isFavorite ? 100 : 50;
    
    totalStakes += stake;

    if (isFavorite) {
      favoriteCount++;
    } else {
      outsiderCount++;
    }

    if (match.teamWon) {
      totalReturns += stake * match.teamOdds;
    }
  }

  const vsv = totalStakes > 0 ? ((totalReturns - totalStakes) / totalStakes) * 100 : 0;

  return {
    totalStakes,
    totalReturns,
    vsv,
    favoriteCount,
    outsiderCount
  };
}

function processMatches(matches, league) {
  const teamStats = new Map();

  for (let match of matches) {
    if (!match.homeOdds || !match.awayOdds) continue;

    const isDraw = match.scoreHome === match.scoreAway;

    if (!teamStats.has(match.homeTeam)) {
      teamStats.set(match.homeTeam, []);
    }
    teamStats.get(match.homeTeam).push({
      teamOdds: match.homeOdds,
      opponentOdds: match.awayOdds,
      teamWon: match.scoreHome > match.scoreAway,
      isDraw: isDraw
    });

    if (!teamStats.has(match.awayTeam)) {
      teamStats.set(match.awayTeam, []);
    }
    teamStats.get(match.awayTeam).push({
      teamOdds: match.awayOdds,
      opponentOdds: match.homeOdds,
      teamWon: match.scoreAway > match.scoreHome,
      isDraw: isDraw
    });
  }

  const teams = [];
  for (let [teamName, teamMatches] of teamStats) {
    const stats = calculateVSV(teamMatches);
    teams.push({
      name: teamName,
      league: league.name,
      leagueId: league.id,
      ...stats
    });
  }

  return teams;
}

app.post('/api/scrape', async (req, res) => {
  let browser = null;

  try {
    console.log('Starting browser...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    let allTeams = [];

    for (let league of LEAGUES) {
      const matches = await scrapeLeagueMatches(page, league);
      const teams = processMatches(matches, league);
      allTeams = allTeams.concat(teams);
    }

    allTeams.sort((a, b) => b.vsv - a.vsv);

    await browser.close();

    res.json({
      success: true,
      teams: allTeams,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scraping error:', error);
    
    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
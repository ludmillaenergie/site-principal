/*
 * Le Phare — consentement et script client (ENVIRONNEMENT DE TEST UNIQUEMENT)
 *
 * Ce script :
 *  - affiche une bannière de consentement (aucun identifiant ni événement
 *    avant un choix explicite) ;
 *  - crée visitor_id/session_id uniquement après acceptation ;
 *  - envoie les premiers événements (page_vue, clic_offre) vers le
 *    collecteur de TEST — jamais la production ;
 *  - fournit un point d'entrée permanent pour changer d'avis, retirer son
 *    consentement et effacer ses données.
 *
 * IMPORTANT : COLLECTEUR_URL pointe vers l'environnement de test. Ne pas
 * changer cette valeur sans validation séparée.
 */
(function () {
  'use strict';

  var COLLECTEUR_URL = 'https://le-phare-collecteur-test.ludmillaenergie.workers.dev';

  var CONSENT_MAX_AGE = 180 * 24 * 60 * 60;   // 6 mois, fixe, jamais prolongé
  var VID_MAX_AGE = 396 * 24 * 60 * 60;        // 13 mois, fixe (sous le plafond navigateur de 400 jours)
  var SESSION_MAX_AGE = 4 * 60 * 60;           // 4 h — aligné sur la durée max de session
  var INACTIVITE_MS = 30 * 60 * 1000;          // nouvelle session après 30 min d'inactivité
  var SESSION_ABSOLUE_MS = 4 * 60 * 60 * 1000; // durée max d'une session continue

  // Association href -> code d'offre pour le suivi des clics sur la page
  // d'accueil. Recherche par sous-chaîne : peu importe le chemin exact
  // (relatif ou absolu), tant que le fragment reconnaissable est présent.
  var OFFRES_PAR_HREF = [
    ['le-repere-partage', 'repere'],
    ['oracle-traversee.html', 'traversee'],
    ['oracle-evidences.html', 'evidences'],
    ['oracle-hemera.html', 'hemera'],
    ['suivi-clics.ludmillaenergie.workers.dev/seances', 'seances'],
    ['suivi-clics.ludmillaenergie.workers.dev/passage', 'passage'],
    ['suivi-clics.ludmillaenergie.workers.dev/manifestes', 'manifestes']
  ];

  // ---------------------------------------------------------------------
  // Cookies
  // ---------------------------------------------------------------------

  function lireCookie(nom) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + nom + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function ecrireCookie(nom, valeur, maxAgeSecondes) {
    var securise = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = nom + '=' + encodeURIComponent(valeur) +
      '; Path=/; Max-Age=' + maxAgeSecondes + '; SameSite=Lax' + securise;
  }

  function supprimerCookie(nom) {
    document.cookie = nom + '=; Path=/; Max-Age=0; SameSite=Lax';
  }

  function genererId(prefixe) {
    var octets = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(octets);
    var hex = Array.prototype.map.call(octets, function (o) {
      return o.toString(16).padStart(2, '0');
    }).join('');
    return prefixe + '_' + hex; // toujours >= 8 caractères, conforme à idValide()
  }

  // ---------------------------------------------------------------------
  // Consentement
  // ---------------------------------------------------------------------

  function etatConsentement() {
    var v = lireCookie('lp_consent');
    return v === 'accepted' || v === 'refused' ? v : null;
  }

  function definirConsentement(valeur) {
    ecrireCookie('lp_consent', valeur, CONSENT_MAX_AGE);
    ecrireCookie('lp_consent_date', new Date().toISOString(), CONSENT_MAX_AGE);
  }

  // ---------------------------------------------------------------------
  // Identifiants — uniquement appelés quand le consentement est "accepted"
  // ---------------------------------------------------------------------

  function assurerVisitorId() {
    var vid = lireCookie('lp_vid');
    if (!vid) {
      vid = genererId('v');
      ecrireCookie('lp_vid', vid, VID_MAX_AGE); // durée fixe, jamais prolongée ensuite
    }
    return vid;
  }

  function assurerSessionId() {
    var maintenant = Date.now();
    var sid = lireCookie('lp_sid');
    var debut = parseInt(lireCookie('lp_session_debut') || '0', 10);
    var derniere = parseInt(lireCookie('lp_derniere_activite') || '0', 10);

    var nouvelleSession = !sid ||
      (maintenant - derniere > INACTIVITE_MS) ||
      (maintenant - debut > SESSION_ABSOLUE_MS);

    if (nouvelleSession) {
      sid = genererId('s');
      debut = maintenant;
      ecrireCookie('lp_session_debut', String(debut), SESSION_MAX_AGE);
    }
    ecrireCookie('lp_sid', sid, SESSION_MAX_AGE);
    ecrireCookie('lp_derniere_activite', String(maintenant), SESSION_MAX_AGE);
    return sid;
  }

  // ---------------------------------------------------------------------
  // Envoi d'événements — jamais avant acceptation explicite
  // ---------------------------------------------------------------------

  function envoyerEvenement(type, champs) {
    if (etatConsentement() !== 'accepted') return;
    var corps = Object.assign({
      event_id: genererId('e'),
      visitor_id: assurerVisitorId(),
      session_id: assurerSessionId(),
      type: type,
      occurred_at: new Date().toISOString(),
      environnement: 'test'
    }, champs || {});

    fetch(COLLECTEUR_URL + '/collecte', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      keepalive: true
    }).catch(function () { /* best-effort : ne bloque jamais la navigation */ });
  }

  // ---------------------------------------------------------------------
  // Suppression des données — appelle d'abord le collecteur (avec le
  // cookie lp_vid existant), puis seulement ensuite supprime les cookies
  // locaux, dans cet ordre précis.
  // ---------------------------------------------------------------------

  function effacerMesDonnees(callback) {
    fetch(COLLECTEUR_URL + '/effacer-mes-donnees', {
      method: 'POST',
      credentials: 'include'
    }).catch(function () { /* best-effort */ }).then(function () {
      supprimerCookie('lp_vid');
      supprimerCookie('lp_sid');
      supprimerCookie('lp_session_debut');
      supprimerCookie('lp_derniere_activite');
      if (callback) callback();
    });
  }

  // ---------------------------------------------------------------------
  // Suivi des clics sur les cartes d'offre (page d'accueil)
  // ---------------------------------------------------------------------

  function offreDepuisHref(href) {
    for (var i = 0; i < OFFRES_PAR_HREF.length; i++) {
      if (href.indexOf(OFFRES_PAR_HREF[i][0]) !== -1) return OFFRES_PAR_HREF[i][1];
    }
    return null;
  }

  function attacherSuiviClics() {
    var liens = document.querySelectorAll('a.oracle-carte');
    liens.forEach(function (lien) {
      var offre = offreDepuisHref(lien.getAttribute('href') || '');
      if (!offre) return;
      lien.addEventListener('click', function () {
        envoyerEvenement('clic_offre', { offre: offre });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Interface — styles (palette Ludmilla Énergie : ivoire / violet / or)
  // ---------------------------------------------------------------------

  function injecterStyles() {
    var style = document.createElement('style');
    style.textContent = [
      '.lp-bandeau, .lp-panneau-fond{font-family:"Raleway",sans-serif;}',
      '.lp-bandeau{position:fixed;left:0;right:0;bottom:0;z-index:99999;',
      'background:#f3ead9;color:#2a2030;border-top:1px solid #c8a96e;',
      'box-shadow:0 -4px 24px rgba(42,32,48,0.18);',
      'padding:18px 20px;display:flex;flex-wrap:wrap;align-items:center;',
      'justify-content:center;gap:16px;}',
      '.lp-bandeau-texte{flex:1 1 380px;max-width:640px;font-size:14px;',
      'line-height:1.6;margin:0;}',
      '.lp-bandeau-titre{font-family:"Cormorant Garamond",serif;font-style:italic;',
      'font-size:19px;color:#2a2030;margin:0 0 4px;}',
      '.lp-boutons{display:flex;gap:12px;flex:0 0 auto;}',
      '.lp-btn{font-family:"Raleway",sans-serif;font-size:13.5px;font-weight:600;',
      'padding:11px 22px;border-radius:999px;cursor:pointer;border:1.5px solid #c8a96e;',
      'min-width:120px;text-align:center;line-height:1.2;transition:opacity .15s;}',
      '.lp-btn:hover{opacity:.85;}',
      '.lp-btn-accepter{background:#c8a96e;color:#2a2030;}',
      '.lp-btn-refuser{background:transparent;color:#2a2030;}',
      '.lp-lien-permanent{position:fixed;left:16px;bottom:14px;z-index:99998;',
      'font-family:"Raleway",sans-serif;font-size:11.5px;color:#2a2030;',
      'background:#f3ead9;border:1px solid #c8a96e;border-radius:999px;',
      'padding:7px 14px;text-decoration:none;opacity:.85;}',
      '.lp-lien-permanent:hover{opacity:1;}',
      '.lp-panneau-fond{position:fixed;inset:0;z-index:100000;',
      'background:rgba(42,32,48,0.35);display:flex;align-items:center;',
      'justify-content:center;padding:20px;}',
      '.lp-panneau{background:#f3ead9;color:#2a2030;border-radius:14px;',
      'max-width:420px;width:100%;padding:28px 26px;box-shadow:0 12px 40px rgba(42,32,48,0.3);}',
      '.lp-panneau h2{font-family:"Cormorant Garamond",serif;font-style:italic;',
      'font-size:22px;margin:0 0 14px;color:#2a2030;}',
      '.lp-panneau p{font-size:13.5px;line-height:1.6;margin:0 0 18px;}',
      '.lp-panneau .lp-statut{font-weight:600;}',
      '.lp-panneau-boutons{display:flex;flex-direction:column;gap:10px;}',
      '.lp-btn-large{width:100%;padding:12px 20px;}',
      '.lp-btn-fermer{background:transparent;border:none;color:#2a2030;',
      'opacity:.6;font-size:12px;cursor:pointer;margin-top:14px;',
      'font-family:"Raleway",sans-serif;text-decoration:underline;}',
      '@media (max-width:480px){.lp-bandeau{flex-direction:column;',
      'align-items:stretch;padding:16px;}.lp-boutons{justify-content:stretch;}',
      '.lp-btn{flex:1;}}'
    ].join('');
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // Bannière initiale
  // ---------------------------------------------------------------------

  function afficherBanniere() {
    if (document.querySelector('.lp-bandeau')) return;
    var bandeau = document.createElement('div');
    bandeau.className = 'lp-bandeau';
    bandeau.setAttribute('role', 'dialog');
    bandeau.setAttribute('aria-label', 'Consentement à la mesure de fréquentation');
    bandeau.innerHTML =
      '<p class="lp-bandeau-texte">' +
        '<span class="lp-bandeau-titre">Une mesure discrète, jamais imposée</span><br>' +
        'Ce site utilise une mesure de fréquentation anonyme pour comprendre comment il est parcouru et l’améliorer. ' +
        'Aucune donnée n’est collectée sans ton accord, et tu peux changer d’avis à tout moment.' +
      '</p>' +
      '<div class="lp-boutons">' +
        '<button type="button" class="lp-btn lp-btn-refuser" data-lp-action="refuser">Refuser</button>' +
        '<button type="button" class="lp-btn lp-btn-accepter" data-lp-action="accepter">Accepter</button>' +
      '</div>';
    document.body.appendChild(bandeau);

    bandeau.querySelector('[data-lp-action="accepter"]').addEventListener('click', function () {
      definirConsentement('accepted');
      bandeau.remove();
      envoyerEvenement('page_vue', { page: location.pathname });
      attacherSuiviClics();
    });
    bandeau.querySelector('[data-lp-action="refuser"]').addEventListener('click', function () {
      definirConsentement('refused');
      bandeau.remove();
    });
  }

  // ---------------------------------------------------------------------
  // Lien permanent + panneau de gestion
  // ---------------------------------------------------------------------

  function libelleStatut(etat) {
    if (etat === 'accepted') return 'Mesure actuellement activée.';
    if (etat === 'refused') return 'Mesure actuellement désactivée.';
    return 'Aucun choix enregistré pour l’instant.';
  }

  function fermerPanneau() {
    var fond = document.querySelector('.lp-panneau-fond');
    if (fond) fond.remove();
  }

  function afficherPanneau() {
    fermerPanneau();
    var etat = etatConsentement();
    var fond = document.createElement('div');
    fond.className = 'lp-panneau-fond';

    var boutonsHtml = '';
    if (etat === 'accepted') {
      boutonsHtml =
        '<button type="button" class="lp-btn lp-btn-refuser lp-btn-large" data-lp-action="retirer">' +
          'Retirer mon consentement et effacer mes données' +
        '</button>';
    } else {
      boutonsHtml =
        '<button type="button" class="lp-btn lp-btn-accepter lp-btn-large" data-lp-action="accepter">Accepter</button>' +
        '<button type="button" class="lp-btn lp-btn-refuser lp-btn-large" data-lp-action="refuser">Refuser</button>';
    }

    fond.innerHTML =
      '<div class="lp-panneau" role="dialog" aria-label="Gérer mes cookies et mes données">' +
        '<h2>Gérer mes cookies et mes données</h2>' +
        '<p><span class="lp-statut">' + libelleStatut(etat) + '</span><br>' +
        'Tu peux changer d’avis à tout moment. Si tu retires ton consentement, ' +
        'les données déjà mesurées associées à cet appareil sont effacées.</p>' +
        '<div class="lp-panneau-boutons">' + boutonsHtml + '</div>' +
        '<button type="button" class="lp-btn-fermer" data-lp-action="fermer">Fermer</button>' +
      '</div>';
    document.body.appendChild(fond);

    var accepter = fond.querySelector('[data-lp-action="accepter"]');
    if (accepter) accepter.addEventListener('click', function () {
      definirConsentement('accepted');
      fermerPanneau();
      envoyerEvenement('page_vue', { page: location.pathname });
      attacherSuiviClics();
    });

    var refuser = fond.querySelector('[data-lp-action="refuser"]');
    if (refuser) refuser.addEventListener('click', function () {
      definirConsentement('refused');
      fermerPanneau();
    });

    var retirer = fond.querySelector('[data-lp-action="retirer"]');
    if (retirer) retirer.addEventListener('click', function () {
      retirer.disabled = true;
      retirer.textContent = 'Effacement en cours…';
      effacerMesDonnees(function () {
        definirConsentement('refused');
        fermerPanneau();
      });
    });

    fond.querySelector('[data-lp-action="fermer"]').addEventListener('click', fermerPanneau);
    fond.addEventListener('click', function (e) {
      if (e.target === fond) fermerPanneau();
    });
  }

  function creerLienPermanent() {
    if (document.querySelector('.lp-lien-permanent')) return;
    var lien = document.createElement('a');
    lien.href = '#';
    lien.className = 'lp-lien-permanent';
    lien.textContent = 'Gérer mes cookies et mes données';
    lien.addEventListener('click', function (e) {
      e.preventDefault();
      afficherPanneau();
    });
    document.body.appendChild(lien);
  }

  // ---------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------

  function init() {
    injecterStyles();
    creerLienPermanent();

    var etat = etatConsentement();
    if (etat === 'accepted') {
      envoyerEvenement('page_vue', { page: location.pathname });
      attacherSuiviClics();
    } else if (etat === null) {
      afficherBanniere();
    }
    // etat === 'refused' : rien d'autre à faire, seul le lien permanent reste visible
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

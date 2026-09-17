/*
 * Le Phare — consentement et script client (PRODUCTION)
 *
 * Ce script :
 *  - affiche une bannière de consentement (aucun identifiant ni événement
 *    avant un choix explicite) ;
 *  - crée visitor_id/session_id uniquement après acceptation ;
 *  - envoie les premiers événements (page_vue, clic_offre) vers le
 *    collecteur de production ;
 *  - fournit un point d'entrée permanent pour changer d'avis, retirer son
 *    consentement et effacer ses données ;
 *  - partage lp_consent, lp_consent_date, lp_vid, lp_sid, lp_session_debut
 *    et lp_derniere_activite avec Le Repère (lerepere.ludmillaenergie.fr)
 *    via Domain=ludmillaenergie.fr, pour que le même choix et le même
 *    visitor_id vaillent des deux côtés. lp_vid_cree_le et lp_delete_token
 *    restent strictement propres à ce site : Le Repère ne les voit jamais.
 */
(function () {
  'use strict';

  var COLLECTEUR_URL = 'https://le-phare-collecteur.ludmillaenergie.workers.dev';
  var DOMAINE_PARTAGE = 'ludmillaenergie.fr';
  var VERSION_MIGRATION = 'lp_cookie_scope_v1';

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
  //
  // Deux familles, jamais interchangeables :
  //  - "partagés" (Domain=ludmillaenergie.fr) : lisibles et inscriptibles
  //    depuis lerepere.ludmillaenergie.fr comme depuis ce site. Réservés à
  //    lp_consent, lp_consent_date, lp_vid, lp_sid, lp_session_debut,
  //    lp_derniere_activite et au drapeau de migration lui-même.
  //  - "host-only" (pas d'attribut Domain) : visibles uniquement sur ce
  //    site. lp_vid_cree_le et lp_delete_token restent ici pour toujours.
  //
  // lireCookie() ne distingue pas les deux : document.cookie ne renvoie
  // jamais l'attribut Domain. Tant que la migration ci-dessous ne laisse
  // jamais coexister deux valeurs différentes pour un même nom, cette
  // lecture reste sans ambiguïté.

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

  function ecrireCookiePartage(nom, valeur, maxAgeSecondes) {
    var securise = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = nom + '=' + encodeURIComponent(valeur) +
      '; Path=/; Domain=' + DOMAINE_PARTAGE + '; Max-Age=' + maxAgeSecondes +
      '; SameSite=Lax' + securise;
  }

  function supprimerCookiePartage(nom) {
    document.cookie = nom + '=; Path=/; Domain=' + DOMAINE_PARTAGE + '; Max-Age=0; SameSite=Lax';
  }

  function genererId(prefixe) {
    var octets = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(octets);
    var hex = Array.prototype.map.call(octets, function (o) {
      return o.toString(16).padStart(2, '0');
    }).join('');
    return prefixe + '_' + hex; // toujours >= 8 caractères, conforme à idValide()
  }

  // Durée restante (en secondes, jamais négative) jusqu'à ancreIso + durée
  // totale. Sans ancre connue, renvoie la durée totale (équivaut à ancrer
  // sur maintenant — le seul cas légitime : une valeur réellement neuve).
  // Fonction centrale à la règle « ne jamais prolonger artificiellement une
  // échéance » : toute réécriture d'un cookie déjà existant doit passer par
  // elle plutôt que par la durée pleine.
  function dureeRestanteSecondes(ancreIso, dureeTotaleSecondes) {
    var ancreMs = ancreIso ? Date.parse(ancreIso) : NaN;
    if (isNaN(ancreMs)) return dureeTotaleSecondes;
    return Math.max(0, Math.floor((ancreMs + dureeTotaleSecondes * 1000 - Date.now()) / 1000));
  }

  // ---------------------------------------------------------------------
  // Migration des anciens cookies host-only vers les cookies partagés
  // ---------------------------------------------------------------------
  //
  // Ordre impératif, pour ne jamais perdre un choix déjà exprimé :
  //   1. lire et mémoriser les valeurs host-only actuelles ;
  //   2. écrire les cookies partagés avec exactement les mêmes valeurs,
  //      sur des échéances ancrées à leur origine réelle (jamais remises à
  //      "maintenant + durée pleine") ;
  //   3. supprimer ensuite les anciennes variantes host-only ;
  //   4. poser lp_cookie_scope_v1 pour ne plus jamais rejouer cette suite.
  //
  // Entre les étapes 2 et 3, un même nom peut brièvement exister à la fois
  // en host-only et en partagé — sans ambiguïté de lecture, puisque les
  // deux portent alors la même valeur (copiée à l'étape 2, jamais recalculée).
  function migrerCookiesPartages() {
    if (lireCookie(VERSION_MIGRATION) === '1') return; // déjà fait

    var anciennes = {
      lp_consent: lireCookie('lp_consent'),
      lp_consent_date: lireCookie('lp_consent_date'),
      lp_vid: lireCookie('lp_vid'),
      lp_sid: lireCookie('lp_sid'),
      lp_session_debut: lireCookie('lp_session_debut'),
      lp_derniere_activite: lireCookie('lp_derniere_activite')
    };

    // 2a. Consentement — ancré sur sa propre date, jamais prolongé.
    if (anciennes.lp_consent) {
      var dureeConsent = dureeRestanteSecondes(anciennes.lp_consent_date, CONSENT_MAX_AGE);
      if (dureeConsent > 0) {
        ecrireCookiePartage('lp_consent', anciennes.lp_consent, dureeConsent);
        if (anciennes.lp_consent_date) {
          ecrireCookiePartage('lp_consent_date', anciennes.lp_consent_date, dureeConsent);
        }
      }
    }

    // 2b. Identifiant visiteur — ancré sur lp_vid_cree_le, ou à défaut sur
    // lp_consent_date (jamais sur aujourd'hui). assurerAncreVid() répare au
    // passage lp_vid_cree_le s'il manquait, sans jamais le réinitialiser
    // s'il existait déjà.
    if (anciennes.lp_vid) {
      var ancreVid = assurerAncreVid();
      var dureeVid = dureeRestanteSecondes(ancreVid, VID_MAX_AGE);
      if (dureeVid > 0) {
        ecrireCookiePartage('lp_vid', anciennes.lp_vid, dureeVid);
      }
    }

    // 2c. Cookies de session — logique de roulement inchangée, on ne fait
    // que recopier la valeur courante sur la durée de session habituelle.
    if (anciennes.lp_sid) {
      ecrireCookiePartage('lp_sid', anciennes.lp_sid, SESSION_MAX_AGE);
    }
    if (anciennes.lp_session_debut) {
      ecrireCookiePartage('lp_session_debut', anciennes.lp_session_debut, SESSION_MAX_AGE);
    }
    if (anciennes.lp_derniere_activite) {
      ecrireCookiePartage('lp_derniere_activite', anciennes.lp_derniere_activite, SESSION_MAX_AGE);
    }

    // 3. Suppression des anciennes variantes host-only — seulement celles
    // qui existaient. lp_vid_cree_le et lp_delete_token ne sont jamais
    // touchés ici : ils restent host-only pour toujours.
    if (anciennes.lp_consent !== null) supprimerCookie('lp_consent');
    if (anciennes.lp_consent_date !== null) supprimerCookie('lp_consent_date');
    if (anciennes.lp_vid !== null) supprimerCookie('lp_vid');
    if (anciennes.lp_sid !== null) supprimerCookie('lp_sid');
    if (anciennes.lp_session_debut !== null) supprimerCookie('lp_session_debut');
    if (anciennes.lp_derniere_activite !== null) supprimerCookie('lp_derniere_activite');

    // 4. Drapeau de version — partagé, longue durée, jamais renouvelé par
    // la suite : si jamais il expirait un jour très lointain, la migration
    // se rejouerait sur un état déjà vide (aucune variante host-only à
    // reprendre) et ne ferait donc rien de plus qu'un no-op.
    ecrireCookiePartage(VERSION_MIGRATION, '1', VID_MAX_AGE);
  }

  // Si le retrait de consentement a été effectué depuis Le Repère,
  // lp_consent=refused arrive ici en cookie partagé, mais lp_delete_token
  // et lp_vid_cree_le — strictement host-only à ce site — n'ont pas pu être
  // nettoyés depuis là-bas. On les supprime nous-mêmes dès la prochaine
  // visite, sans envoyer aucun événement : le retrait est déjà enregistré,
  // il ne s'agit que d'un nettoyage local.
  function nettoyerResidusHostOnlySiRefus() {
    if (etatConsentement() !== 'refused') return;
    if (lireCookie('lp_delete_token') !== null) supprimerCookie('lp_delete_token');
    if (lireCookie('lp_vid_cree_le') !== null) supprimerCookie('lp_vid_cree_le');
  }

  // ---------------------------------------------------------------------
  // Consentement
  // ---------------------------------------------------------------------

  function etatConsentement() {
    var v = lireCookie('lp_consent');
    return v === 'accepted' || v === 'refused' ? v : null;
  }

  function definirConsentement(valeur) {
    ecrireCookiePartage('lp_consent', valeur, CONSENT_MAX_AGE);
    ecrireCookiePartage('lp_consent_date', new Date().toISOString(), CONSENT_MAX_AGE);
  }

  // ---------------------------------------------------------------------
  // Identifiants — uniquement appelés quand le consentement est "accepted"
  // ---------------------------------------------------------------------

  // Retourne l'ISO de création à utiliser comme ancre pour lp_vid, en
  // créant lp_vid_cree_le (host-only) s'il manque. Ne jamais ancrer sur
  // "maintenant" tant qu'une date de consentement existe : cela repousserait
  // indûment l'horizon d'expiration du jeton d'effacement. Ne touche jamais
  // lp_vid_cree_le s'il existe déjà.
  function assurerAncreVid() {
    var ancre = lireCookie('lp_vid_cree_le');
    if (ancre) return ancre;

    var repli = lireCookie('lp_consent_date') || new Date().toISOString();
    var dureeRestante = dureeRestanteSecondes(repli, VID_MAX_AGE);
    if (dureeRestante > 0) {
      ecrireCookie('lp_vid_cree_le', repli, dureeRestante);
    }
    return repli;
  }

  function assurerVisitorId() {
    var vid = lireCookie('lp_vid');
    if (!vid) {
      vid = genererId('v');
      var maintenant = new Date().toISOString();
      ecrireCookiePartage('lp_vid', vid, VID_MAX_AGE); // durée fixe, jamais prolongée ensuite
      // Nouveau visiteur : l'ancre est bien "maintenant", ici et seulement ici.
      ecrireCookie('lp_vid_cree_le', maintenant, VID_MAX_AGE);
    } else {
      // lp_vid existait déjà (créé ici ou partagé depuis Le Repère) :
      // s'assurer que son ancre existe, sans jamais la réinitialiser.
      assurerAncreVid();
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
      ecrireCookiePartage('lp_session_debut', String(debut), SESSION_MAX_AGE);
    }
    ecrireCookiePartage('lp_sid', sid, SESSION_MAX_AGE);
    ecrireCookiePartage('lp_derniere_activite', String(maintenant), SESSION_MAX_AGE);
    return sid;
  }

  // ---------------------------------------------------------------------
  // Jeton d'effacement — reçu dans la réponse JSON de /collecte, jamais via
  // un cookie posé par le collecteur (qui serait sur un autre domaine et
  // donc invisible ici). Conservé dans lp_delete_token, host-only à ce
  // site, pour être renvoyé explicitement lors d'une demande d'effacement.
  // ---------------------------------------------------------------------

  function memoriserJetonEffacement(jeton) {
    if (!jeton) return;
    // Ne jamais remplacer un jeton déjà présent : on ne veut pas repousser
    // son horizon d'expiration à chaque page vue (voir lp_vid_cree_le).
    if (lireCookie('lp_delete_token')) return;

    var maxAgeRestant = dureeRestanteSecondes(lireCookie('lp_vid_cree_le'), VID_MAX_AGE);
    if (maxAgeRestant <= 0) return; // horizon déjà dépassé : inutile de stocker un jeton mort

    ecrireCookie('lp_delete_token', jeton, maxAgeRestant);
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
      visitor_cree_le: lireCookie('lp_vid_cree_le'),
      type: type,
      occurred_at: new Date().toISOString(),
      environnement: 'production'
    }, champs || {});

    fetch(COLLECTEUR_URL + '/collecte', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      keepalive: true
    }).then(function (reponse) {
      return reponse && reponse.ok ? reponse.json() : null;
    }).then(function (donnees) {
      if (donnees) memoriserJetonEffacement(donnees.deletion_token);
    }).catch(function () { /* best-effort : ne bloque jamais la navigation */ });
  }

  // ---------------------------------------------------------------------
  // Retrait du consentement — le retrait prend effet immédiatement, que
  // la demande d'effacement réussisse ou non :
  //   1. toute nouvelle collecte est stoppée et le refus enregistré tout
  //      de suite (definirConsentement('refused') avant l'appel réseau) ;
  //   2. le jeton d'effacement (lp_delete_token) identifie le visiteur
  //      auprès du collecteur — plus un cookie transmis automatiquement par
  //      le navigateur (lp_vid n'est jamais envoyé au collecteur : cookie du
  //      domaine du site, pas du sien), mais une valeur que ce script lit
  //      lui-même et transmet explicitement dans le corps de la requête ;
  //   3. lp_vid/lp_sid (et les cookies de session), désormais partagés, et
  //      lp_vid_cree_le/lp_delete_token, restés host-only, sont ensuite
  //      supprimés dans tous les cas — succès, échec serveur (400) ou échec
  //      réseau — jamais de réactivation de la collecte.
  // Le callback reçoit `succes` (booléen) pour permettre d'informer la
  // personne, sobrement, si l'effacement n'a pas pu être confirmé.
  //
  // LIMITE CONNUE (acceptée pour l'instant, aucun mécanisme de rattrapage
  // construit) : si la personne retire son consentement avant que la
  // réponse du tout premier /collecte ne soit revenue, lp_delete_token
  // n'existe pas encore. La demande d'effacement part donc avec
  // deletion_token: null, le serveur la refuse (400, comportement identique
  // à un jeton absent, voir test/deletion-token.test.js et
  // test/collecte.test.js côté collecteur), et « Effacement non confirmé »
  // s'affiche — alors même que, dans cette fenêtre étroite, un premier
  // événement a pu être écrit côté collecteur juste avant. Comme lp_vid est
  // supprimé immédiatement quel que soit le résultat, aucune nouvelle
  // tentative en libre-service n'est ensuite possible pour cette ligne
  // précise (le visitor_id qui la désignait n'existe plus dans ce
  // navigateur). Pas de correctif construit à ce stade : la fenêtre est
  // étroite (le temps d'un aller-retour réseau), et le comportement reste
  // honnête (jamais de faux succès) plutôt que silencieusement inexact.
  // ---------------------------------------------------------------------

  function effacerMesDonnees(callback) {
    definirConsentement('refused');
    var jeton = lireCookie('lp_delete_token');

    fetch(COLLECTEUR_URL + '/effacer-mes-donnees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletion_token: jeton })
    }).then(function (reponse) {
      return !!(reponse && reponse.ok);
    }).catch(function () {
      return false;
    }).then(function (succes) {
      supprimerCookiePartage('lp_vid');
      supprimerCookie('lp_vid_cree_le');
      supprimerCookiePartage('lp_sid');
      supprimerCookiePartage('lp_session_debut');
      supprimerCookiePartage('lp_derniere_activite');
      supprimerCookie('lp_delete_token');
      if (callback) callback(succes);
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
      'align-items:stretch;padding:16px;}',
      '.lp-bandeau-texte{flex-basis:auto;}',
      '.lp-boutons{justify-content:stretch;}',
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
        'Avec ton accord, ce site utilise des cookies de mesure pour comprendre comment il est parcouru et ' +
        'améliorer ce qui doit l’être. Ils ne contiennent ni ton nom, ni ton adresse e-mail, ni ce que tu écris ' +
        'dans Le Repère ou Le Passage. Tu peux refuser ou changer d’avis à tout moment.' +
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
      effacerMesDonnees(function (succes) {
        fermerPanneau();
        if (!succes) afficherMessageEchecEffacement();
      });
    });

    fond.querySelector('[data-lp-action="fermer"]').addEventListener('click', fermerPanneau);
    fond.addEventListener('click', function (e) {
      if (e.target === fond) fermerPanneau();
    });
  }

  // Message sobre affiché lorsque le retrait a bien été pris en compte
  // (plus aucune collecte, choix déjà enregistré en refus) mais que la
  // demande d'effacement n'a pas pu être confirmée par le serveur.
  function afficherMessageEchecEffacement() {
    var fond = document.createElement('div');
    fond.className = 'lp-panneau-fond';
    fond.innerHTML =
      '<div class="lp-panneau" role="dialog" aria-label="Effacement non confirmé">' +
        '<h2>Effacement non confirmé</h2>' +
        '<p>Ton consentement est retiré : aucune nouvelle mesure ne sera envoyée depuis cet appareil. ' +
        'La demande d’effacement des données déjà mesurées n’a en revanche pas pu être confirmée par le serveur.</p>' +
        '<button type="button" class="lp-btn-fermer" data-lp-action="fermer">Fermer</button>' +
      '</div>';
    document.body.appendChild(fond);
    fond.querySelector('[data-lp-action="fermer"]').addEventListener('click', function () { fond.remove(); });
    fond.addEventListener('click', function (e) { if (e.target === fond) fond.remove(); });
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
    migrerCookiesPartages();
    nettoyerResidusHostOnlySiRefus();
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

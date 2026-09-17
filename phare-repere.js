/*
 * Le Phare — script de consentement et de mesure minimale pour Le Repère
 * (PRODUCTION)
 *
 * Chargé en cross-origin sur lerepere.ludmillaenergie.fr. Il s'exécute
 * dans le contexte de cette page : ses écritures document.cookie suivent
 * donc les règles normales de portée de cookie pour ce sous-domaine.
 *
 * Ce script ne modifie jamais le Worker ni le parcours d'inscription du
 * Repère (fichier index.html non touché, hormis la balise <script> qui le
 * charge). Il ne fait que :
 *  - lire/écrire les cookies PARTAGÉS posés par le site principal
 *    (Domain=ludmillaenergie.fr) : lp_consent, lp_consent_date, lp_vid,
 *    lp_sid, lp_session_debut, lp_derniere_activite ;
 *  - afficher le même choix de consentement que sur le site, pour une
 *    personne arrivant directement ici sans être jamais passée par
 *    ludmillaenergie.fr ;
 *  - envoyer avant_gout_demarre au clic sur l'aperçu gratuit, uniquement
 *    si le consentement est "accepted", sans aucune donnée de naissance,
 *    de thème ou de profil ;
 *  - offrir un retrait de consentement et une demande d'effacement,
 *    équivalents à ceux du site, via un lien permanent "Gérer mes cookies
 *    et mes données" ;
 *  - garder son propre jeton d'effacement dans un cookie host-only à ce
 *    seul sous-domaine (lp_repere_delete_token) — jamais partagé, jamais
 *    vu par le site principal, qui a le sien (lp_delete_token, distinct).
 *  - ne jamais transmettre visitor_id au Worker du Repère : la mesure et
 *    le compte du Repère restent deux circuits séparés.
 */
(function () {
  'use strict';

  var COLLECTEUR_URL = 'https://le-phare-collecteur.ludmillaenergie.workers.dev';
  var DOMAINE_PARTAGE = 'ludmillaenergie.fr';

  var CONSENT_MAX_AGE = 180 * 24 * 60 * 60;   // 6 mois, fixe, jamais prolongé
  var VID_MAX_AGE = 396 * 24 * 60 * 60;        // 13 mois, fixe (sous le plafond navigateur de 400 jours)
  var SESSION_MAX_AGE = 4 * 60 * 60;           // 4 h — aligné sur la durée max de session
  var INACTIVITE_MS = 30 * 60 * 1000;          // nouvelle session après 30 min d'inactivité
  var SESSION_ABSOLUE_MS = 4 * 60 * 60 * 1000; // durée max d'une session continue

  // ---------------------------------------------------------------------
  // Cookies
  // ---------------------------------------------------------------------

  function lireCookie(nom) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + nom + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
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

  // Jeton d'effacement propre à Le Repère : host-only à ce seul
  // sous-domaine, sans attribut Domain — le site principal ne le voit
  // jamais, et lp_delete_token (site) n'est jamais visible ici non plus.
  function ecrireCookieHostOnly(nom, valeur, maxAgeSecondes) {
    var securise = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = nom + '=' + encodeURIComponent(valeur) +
      '; Path=/; Max-Age=' + maxAgeSecondes + '; SameSite=Lax' + securise;
  }

  function supprimerCookieHostOnly(nom) {
    document.cookie = nom + '=; Path=/; Max-Age=0; SameSite=Lax';
  }

  function genererId(prefixe) {
    var octets = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(octets);
    var hex = Array.prototype.map.call(octets, function (o) {
      return o.toString(16).padStart(2, '0');
    }).join('');
    return prefixe + '_' + hex;
  }

  // Identique à la fonction du site : durée restante jusqu'à ancreIso +
  // durée totale, jamais négative, jamais recalculée sur "maintenant" tant
  // qu'une ancre existe.
  function dureeRestanteSecondes(ancreIso, dureeTotaleSecondes) {
    var ancreMs = ancreIso ? Date.parse(ancreIso) : NaN;
    if (isNaN(ancreMs)) return dureeTotaleSecondes;
    return Math.max(0, Math.floor((ancreMs + dureeTotaleSecondes * 1000 - Date.now()) / 1000));
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
  // Identifiants — Le Repère ne crée jamais lp_vid_cree_le : cette ancre
  // reste une affaire strictement host-only au site principal. Si ce
  // visiteur y arrive plus tard sans elle, phare-consentement.js l'ancrera
  // lui-même sur lp_consent_date — jamais sur "aujourd'hui" (voir
  // assurerAncreVid côté site).
  // ---------------------------------------------------------------------

  function assurerVisitorId() {
    var vid = lireCookie('lp_vid');
    if (!vid) {
      vid = genererId('v');
      ecrireCookiePartage('lp_vid', vid, VID_MAX_AGE);
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
  // Jeton d'effacement local à Le Repère — ancré sur lp_consent_date
  // (jamais sur l'instant d'émission de l'événement), pour ne jamais
  // prolonger l'horizon de conservation au-delà de ce que le consentement
  // autorise déjà. Une personne qui démarre son avant-goût plusieurs mois
  // après avoir consenti ne doit pas voir sa durée de suivi prolongée.
  // ---------------------------------------------------------------------

  function memoriserJetonEffacementRepere(jeton) {
    if (!jeton) return;
    if (lireCookie('lp_repere_delete_token')) return;

    var maxAgeRestant = dureeRestanteSecondes(lireCookie('lp_consent_date'), VID_MAX_AGE);
    if (maxAgeRestant <= 0) return;

    ecrireCookieHostOnly('lp_repere_delete_token', jeton, maxAgeRestant);
  }

  // ---------------------------------------------------------------------
  // avant_gout_demarre — jamais avant acceptation explicite, jamais de
  // donnée de naissance/thème/profil, offre=repere pour l'attribution.
  // ---------------------------------------------------------------------

  function envoyerAvantGout() {
    if (etatConsentement() !== 'accepted') return;
    var corps = {
      event_id: genererId('e'),
      visitor_id: assurerVisitorId(),
      session_id: assurerSessionId(),
      type: 'avant_gout_demarre',
      offre: 'repere',
      occurred_at: new Date().toISOString(),
      environnement: 'production'
    };

    fetch(COLLECTEUR_URL + '/collecte', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      keepalive: true
    }).then(function (reponse) {
      return reponse && reponse.ok ? reponse.json() : null;
    }).then(function (donnees) {
      if (donnees) memoriserJetonEffacementRepere(donnees.deletion_token);
    }).catch(function () { /* best-effort : ne bloque jamais l'expérience */ });
  }

  // ---------------------------------------------------------------------
  // Retrait / effacement depuis Le Repère
  //
  //   1. lp_consent=refused est écrit tout de suite en cookie PARTAGÉ : le
  //      site principal respecte ce choix dès sa prochaine visite ;
  //   2. les cookies partagés d'identité/session (lp_vid, lp_sid,
  //      lp_session_debut, lp_derniere_activite) sont supprimés ici —
  //      lp_consent/lp_consent_date sont conservés, ils portent la trace
  //      du refus ;
  //   3. si un jeton local existe, demande d'effacement au collecteur ;
  //      sinon, aucun appel réseau : aucune donnée n'a jamais été
  //      collectée depuis ce navigateur, ce n'est pas un échec ;
  //   4. lp_repere_delete_token est supprimé dans tous les cas.
  // Le callback reçoit `succes` (booléen) pour le même message sobre que
  // sur le site en cas d'échec serveur réel.
  // ---------------------------------------------------------------------

  function retirerConsentement(callback) {
    definirConsentement('refused');
    var jeton = lireCookie('lp_repere_delete_token');

    supprimerCookiePartage('lp_vid');
    supprimerCookiePartage('lp_sid');
    supprimerCookiePartage('lp_session_debut');
    supprimerCookiePartage('lp_derniere_activite');

    if (!jeton) {
      if (callback) callback(true);
      return;
    }

    fetch(COLLECTEUR_URL + '/effacer-mes-donnees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletion_token: jeton })
    }).then(function (reponse) {
      return !!(reponse && reponse.ok);
    }).catch(function () {
      return false;
    }).then(function (succes) {
      supprimerCookieHostOnly('lp_repere_delete_token');
      if (callback) callback(succes);
    });
  }

  // ---------------------------------------------------------------------
  // Interface — mêmes classes/styles que sur le site, pour une continuité
  // visuelle ; les deux scripts ne coexistent jamais sur une même page.
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

  function afficherBanniere() {
    if (document.querySelector('.lp-bandeau')) return;
    var bandeau = document.createElement('div');
    bandeau.className = 'lp-bandeau';
    bandeau.setAttribute('role', 'dialog');
    bandeau.setAttribute('aria-label', 'Consentement à la mesure de fréquentation');
    bandeau.innerHTML =
      '<p class="lp-bandeau-texte">' +
        '<span class="lp-bandeau-titre">Une mesure discrète, jamais imposée</span><br>' +
        'Avec ton accord, Le Repère utilise des cookies de mesure pour comprendre comment il est parcouru et ' +
        'améliorer ce qui doit l’être. Ils ne contiennent ni ton nom, ni ton adresse e-mail, ni ce que tu écris ' +
        'ici. Tu peux refuser ou changer d’avis à tout moment.' +
      '</p>' +
      '<div class="lp-boutons">' +
        '<button type="button" class="lp-btn lp-btn-refuser" data-lp-action="refuser">Refuser</button>' +
        '<button type="button" class="lp-btn lp-btn-accepter" data-lp-action="accepter">Accepter</button>' +
      '</div>';
    document.body.appendChild(bandeau);

    bandeau.querySelector('[data-lp-action="accepter"]').addEventListener('click', function () {
      definirConsentement('accepted');
      bandeau.remove();
    });
    bandeau.querySelector('[data-lp-action="refuser"]').addEventListener('click', function () {
      definirConsentement('refused');
      bandeau.remove();
    });
  }

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
      retirerConsentement(function (succes) {
        fermerPanneau();
        if (!succes) afficherMessageEchecEffacement();
      });
    });

    fond.querySelector('[data-lp-action="fermer"]').addEventListener('click', fermerPanneau);
    fond.addEventListener('click', function (e) {
      if (e.target === fond) fermerPanneau();
    });
  }

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
  // Rattachement à l'aperçu gratuit — un second écouteur indépendant sur
  // #preview-btn, sans toucher au script existant du Repère qui gère,
  // lui, le calcul du thème et l'affichage.
  // ---------------------------------------------------------------------

  function attacherEnvoiAvantGout() {
    var bouton = document.getElementById('preview-btn');
    if (!bouton) return;
    bouton.addEventListener('click', envoyerAvantGout);
  }

  // ---------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------

  function init() {
    injecterStyles();
    creerLienPermanent();
    attacherEnvoiAvantGout();

    if (etatConsentement() === null) {
      afficherBanniere();
    }
    // 'accepted' et 'refused' : rien d'autre à afficher au chargement, le
    // lien permanent suffit ; avant_gout_demarre n'est déclenché que par un
    // clic explicite sur l'aperçu, jamais automatiquement.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

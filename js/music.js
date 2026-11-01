import { AuthRequiredError, SpotifyError } from './spotify.js';

const MAX_QUEUE = 50;
const LOCKED_NOTE = 'Spotify viser ikke numrene i andres playlister. Du kan stadig afspille den.';

// Musikskærmen: søgning, biblioteket og undersider for album, kunstnere og playlister.
export function createMusicView({ doc, spotify, play, errorText, onAuthRequired, signal }) {
  const $ = (id) => doc.getElementById(id);
  let stack = [];
  let activeTab = null;
  let loadToken = 0;
  let sections = new Map();

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const singleSection = (load) => async (offset) => {
    const page = await load(offset);
    return { sections: [{ title: '', rows: page.rows }], nextOffset: page.nextOffset };
  };

  function albumView(album) {
    return {
      title: album.name,
      contextUri: album.uri,
      load: singleSection((offset) => spotify.getAlbumTracks(album.id, offset, album.imageUrl)),
    };
  }

  function artistView(artist) {
    return {
      title: artist.name,
      contextUri: artist.uri,
      load: singleSection((offset) => spotify.getArtistAlbums(artist.id, offset)),
    };
  }

  function playlistView(playlist) {
    return {
      title: playlist.name,
      contextUri: playlist.uri,
      locked: (error) => error instanceof SpotifyError && error.status === 403,
      load: singleSection((offset) => spotify.getPlaylistTracks(playlist.id, offset)),
    };
  }

  function searchView(query) {
    return {
      title: `Søgning: ${query}`,
      isSearch: true,
      emptyText: 'Ingen resultater',
      load: async (offset) => {
        const result = await spotify.search(query, offset);
        return {
          sections: [
            { title: 'Numre', rows: result.tracks },
            { title: 'Kunstnere', rows: result.artists },
            { title: 'Album', rows: result.albums },
            { title: 'Playlister', rows: result.playlists },
          ],
          nextOffset: result.nextOffset,
        };
      },
    };
  }

  const TABS = {
    'music-tab-playlists': () => ({
      title: 'Dine playlister',
      load: singleSection(async () => ({ rows: await spotify.getPlaylists(), nextOffset: null })),
    }),
    'music-tab-saved': () => ({
      title: 'Gemte numre',
      load: singleSection((offset) => spotify.getSavedTracks(offset)),
    }),
    'music-tab-albums': () => ({
      title: 'Gemte album',
      load: singleSection((offset) => spotify.getSavedAlbums(offset)),
    }),
    'music-tab-recent': () => ({
      title: 'Hørt for nylig',
      load: singleSection(() => spotify.getRecentTracks()),
    }),
  };

  function openRow(row, section, view) {
    if (row.kind === 'album') push(albumView(row));
    else if (row.kind === 'artist') push(artistView(row));
    else if (row.kind === 'playlist') push(playlistView(row));
    else if (view.contextUri) play(() => spotify.playContext(view.contextUri, row.uri));
    else {
      const start = section.rows.indexOf(row);
      play(() => spotify.playTracks(section.rows.slice(start, start + MAX_QUEUE).map((item) => item.uri)));
    }
  }

  function rowElement(row, section, view) {
    const button = element('button', 'music-row');
    button.type = 'button';
    if (row.imageUrl?.startsWith('https://')) {
      const image = element('img', 'music-thumb');
      image.alt = '';
      image.loading = 'lazy';
      image.src = row.imageUrl;
      button.append(image);
    } else {
      button.append(element('span', 'music-thumb'));
    }
    const text = element('span', 'music-row-text');
    text.append(element('span', 'music-row-name', row.name), element('span', 'music-row-subtitle', row.subtitle));
    button.append(text);
    button.addEventListener('click', () => openRow(row, section, view));
    const item = element('li');
    item.append(button);
    return item;
  }

  function appendSections(newSections, view) {
    for (const { title, rows } of newSections) {
      if (!rows.length) continue;
      let section = sections.get(title);
      if (!section) {
        section = { list: element('ul', 'music-rows'), rows: [] };
        sections.set(title, section);
        if (title) $('music-list').append(element('h3', '', title));
        $('music-list').append(section.list);
      }
      section.rows.push(...rows);
      section.list.append(...rows.map((row) => rowElement(row, section, view)));
    }
  }

  async function loadPage(view, offset) {
    const token = ++loadToken;
    $('music-note').textContent = 'Henter…';
    $('music-more').hidden = true;
    $('music-retry').hidden = true;
    try {
      const result = await view.load(offset);
      if (token !== loadToken) return;
      appendSections(result.sections, view);
      view.nextOffset = result.nextOffset;
      $('music-more').hidden = result.nextOffset === null;
      $('music-note').textContent = sections.size ? '' : (view.emptyText ?? 'Der er ikke noget her endnu');
    } catch (error) {
      if (token !== loadToken) return;
      if (view.locked?.(error)) {
        $('music-note').textContent = LOCKED_NOTE;
        return;
      }
      $('music-note').textContent = errorText(error);
      view.retryOffset = offset;
      $('music-retry').hidden = false;
      if (error instanceof AuthRequiredError) onAuthRequired();
    }
  }

  function showCurrent() {
    const view = stack.at(-1);
    sections = new Map();
    $('music-list').replaceChildren();
    $('music-list').scrollTop = 0;
    $('music-title').textContent = view.title;
    $('music-back').hidden = stack.length < 2;
    $('music-play-all').hidden = !view.contextUri;
    for (const id of Object.keys(TABS)) $(id).classList.toggle('active', stack.length === 1 && id === activeTab);
    return loadPage(view, 0);
  }

  function push(view) {
    stack.push(view);
    showCurrent();
  }

  function openTab(id) {
    activeTab = id;
    stack = [TABS[id]()];
    showCurrent();
  }

  function on(id, type, handler) {
    $(id).addEventListener(type, handler, { signal });
  }

  for (const id of Object.keys(TABS)) on(id, 'click', () => openTab(id));

  on('music-back', 'click', () => {
    stack.pop();
    showCurrent();
  });

  on('music-close', 'click', () => {
    $('music').hidden = true;
  });

  on('music-more', 'click', () => loadPage(stack.at(-1), stack.at(-1).nextOffset));
  on('music-retry', 'click', () => loadPage(stack.at(-1), stack.at(-1).retryOffset));

  on('music-play-all', 'click', () => {
    const { contextUri } = stack.at(-1);
    play(() => spotify.playContext(contextUri));
  });

  on('music-search-form', 'submit', (event) => {
    event.preventDefault();
    const query = $('music-search').value.trim();
    if (!query) return;
    $('music-search').blur();
    // En ny søgning erstatter den forrige, så tilbage-knappen ikke går gennem dem alle.
    if (stack.at(-1)?.isSearch) stack.pop();
    push(searchView(query));
  });

  return {
    open() {
      $('music').hidden = false;
      if (!stack.length) openTab('music-tab-playlists');
    },
  };
}

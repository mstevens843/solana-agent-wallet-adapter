// In-place DOM morphing — a self-contained, zero-dependency port of morphdom
// (https://github.com/patrick-steele-idem/morphdom, MIT © Patrick Steele-Idem).
//
// Why this exists: the app paints by replacing `appRoot.innerHTML` on every render,
// which destroys and recreates every node. On Android/iOS WebViews that destroy/recreate
// is a visible repaint flash (the Chat-tab "blink"), and it resets the transcript
// scrollTop to 0 every frame (the iOS "frantic up/down"). Morphing diffs the new HTML
// against the live DOM and mutates only what changed, so node identity — and with it
// focus, scroll, text selection, and CSS animation state — survives a re-render.
//
// The algorithm mirrors morphdom v2.7. Internals walk the DOM dynamically, so they are
// typed loosely (`any`); the public surface (`morphdom`, `morphElement`, `MorphOptions`)
// is fully typed.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MorphOptions {
  /** Return a stable key for a node (defaults to its `id`). Keyed nodes are matched
   *  across positions so e.g. chat messages reconcile by `data-chat-msg-id`. */
  getNodeKey?: (node: Node) => string | undefined;
  /** Called before a brand-new node is inserted; return a replacement node, or `false`
   *  to skip insertion. */
  onBeforeNodeAdded?: (node: Node) => Node | false;
  /** Called after a brand-new node (and its subtree) has been inserted. */
  onNodeAdded?: (node: Node) => void;
  /** Called before an existing element is updated from its counterpart. Return `false`
   *  to leave the element (and its whole subtree) untouched. */
  onBeforeElUpdated?: (fromEl: Element, toEl: Element) => boolean;
  /** Called after an existing element has had its attributes synced. */
  onElUpdated?: (el: Element) => void;
  /** Called before a node is discarded; return `false` to keep it. */
  onBeforeNodeDiscarded?: (node: Node) => boolean;
  /** Called after a node has been discarded. */
  onNodeDiscarded?: (node: Node) => void;
  /** Called before an element's children are reconciled; return `false` to skip. */
  onBeforeElChildrenUpdated?: (fromEl: Element, toEl: Element) => boolean;
  /** Morph only the children of `fromNode`, never `fromNode` itself. */
  childrenOnly?: boolean;
}

const ELEMENT_NODE = 1;
const DOCUMENT_FRAGMENT_NODE = 11;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

function noop(): void {
  /* no-op */
}

function defaultGetNodeKey(node: any): string | undefined {
  if (node) {
    return (node.getAttribute && node.getAttribute('id')) || node.id || undefined;
  }
  return undefined;
}

function compareNodeNames(fromEl: any, toEl: any): boolean {
  const fromNodeName: string = fromEl.nodeName;
  const toNodeName: string = toEl.nodeName;
  if (fromNodeName === toNodeName) return true;
  const fromCodeStart = fromNodeName.charCodeAt(0);
  const toCodeStart = toNodeName.charCodeAt(0);
  // One side may be an HTML element (upper-cased nodeName) and the other an SVG/XML
  // node (case-preserved). Normalize before comparing.
  if (fromCodeStart <= 90 && toCodeStart >= 97) {
    return fromNodeName === toNodeName.toUpperCase();
  } else if (toCodeStart <= 90 && fromCodeStart >= 97) {
    return toNodeName === fromNodeName.toUpperCase();
  }
  return false;
}

function createElementNS(name: string, namespaceURI: string | null): Element {
  return !namespaceURI || namespaceURI === 'http://www.w3.org/1999/xhtml'
    ? document.createElement(name)
    : document.createElementNS(namespaceURI, name);
}

function moveChildren(fromEl: any, toEl: any): any {
  let curChild = fromEl.firstChild;
  while (curChild) {
    const nextChild = curChild.nextSibling;
    toEl.appendChild(curChild);
    curChild = nextChild;
  }
  return toEl;
}

function morphAttrs(fromNode: any, toNode: any): void {
  const toNodeAttrs = toNode.attributes;
  for (let i = toNodeAttrs.length - 1; i >= 0; i--) {
    const attr = toNodeAttrs[i];
    const attrName: string = attr.name;
    const attrNamespaceURI: string | null = attr.namespaceURI;
    const attrValue: string = attr.value;
    if (attrNamespaceURI) {
      const localName: string = attr.localName || attrName;
      const fromValue = fromNode.getAttributeNS(attrNamespaceURI, localName);
      if (fromValue !== attrValue) {
        fromNode.setAttributeNS(attrNamespaceURI, attr.prefix ? attrName : localName, attrValue);
      }
    } else {
      const fromValue = fromNode.getAttribute(attrName);
      if (fromValue !== attrValue) {
        fromNode.setAttribute(attrName, attrValue);
      }
    }
  }
  // Remove attributes that exist on the live node but not on the target.
  const fromNodeAttrs = fromNode.attributes;
  for (let d = fromNodeAttrs.length - 1; d >= 0; d--) {
    const attr = fromNodeAttrs[d];
    const attrName: string = attr.name;
    const attrNamespaceURI: string | null = attr.namespaceURI;
    if (attrNamespaceURI) {
      const localName: string = attr.localName || attrName;
      if (!toNode.hasAttributeNS(attrNamespaceURI, localName)) {
        fromNode.removeAttributeNS(attrNamespaceURI, localName);
      }
    } else if (!toNode.hasAttribute(attrName)) {
      fromNode.removeAttribute(attrName);
    }
  }
}

function syncBooleanAttrProp(fromEl: any, toEl: any, name: string): void {
  if (fromEl[name] !== toEl[name]) {
    fromEl[name] = toEl[name];
    if (fromEl[name]) fromEl.setAttribute(name, '');
    else fromEl.removeAttribute(name);
  }
}

// Elements whose live, user-driven state lives in DOM *properties* (not attributes) and
// must be reconciled explicitly so we never clobber what the user typed/selected.
const specialElHandlers: Record<string, (fromEl: any, toEl: any) => void> = {
  OPTION(fromEl, toEl) {
    let parentNode = fromEl.parentNode;
    if (parentNode) {
      let parentName = parentNode.nodeName.toUpperCase();
      if (parentName === 'OPTGROUP') {
        parentNode = parentNode.parentNode;
        parentName = parentNode && parentNode.nodeName.toUpperCase();
      }
      if (parentName === 'SELECT' && !parentNode.hasAttribute('multiple')) {
        if (fromEl.hasAttribute('selected') && !toEl.selected) {
          fromEl.setAttribute('selected', 'selected');
          fromEl.removeAttribute('selected');
        }
        parentNode.selectedIndex = -1;
      }
    }
    syncBooleanAttrProp(fromEl, toEl, 'selected');
  },
  INPUT(fromEl, toEl) {
    syncBooleanAttrProp(fromEl, toEl, 'checked');
    syncBooleanAttrProp(fromEl, toEl, 'disabled');
    if (fromEl.value !== toEl.value) fromEl.value = toEl.value;
    if (!toEl.hasAttribute('value')) fromEl.removeAttribute('value');
  },
  TEXTAREA(fromEl, toEl) {
    const newValue = toEl.value;
    if (fromEl.value !== newValue) fromEl.value = newValue;
    const firstChild = fromEl.firstChild;
    if (firstChild) {
      const oldValue = firstChild.nodeValue;
      if (oldValue === newValue || (!newValue && oldValue === fromEl.placeholder)) return;
      firstChild.nodeValue = newValue;
    }
  },
  SELECT(fromEl, toEl) {
    if (!toEl.hasAttribute('multiple')) {
      let selectedIndex = -1;
      let i = 0;
      let curChild = fromEl.firstChild;
      let optgroup: any;
      let nodeName: string | undefined;
      while (curChild) {
        nodeName = curChild.nodeName && curChild.nodeName.toUpperCase();
        if (nodeName === 'OPTGROUP') {
          optgroup = curChild;
          curChild = optgroup.firstChild;
        } else {
          if (nodeName === 'OPTION') {
            if (curChild.hasAttribute('selected')) {
              selectedIndex = i;
              break;
            }
            i++;
          }
          curChild = curChild.nextSibling;
          if (!curChild && optgroup) {
            curChild = optgroup.nextSibling;
            optgroup = null;
          }
        }
      }
      fromEl.selectedIndex = selectedIndex;
    }
  },
};

/** Diff `toNode` onto `fromNode` in place, reusing existing nodes. Returns the morphed node. */
export function morphdom(fromNode: Node, toNode: Node, options: MorphOptions = {}): Node {
  const getNodeKey = options.getNodeKey || (defaultGetNodeKey as (n: Node) => string | undefined);
  const onBeforeNodeAdded = options.onBeforeNodeAdded || (noop as any);
  const onNodeAdded = options.onNodeAdded || noop;
  const onBeforeElUpdated = options.onBeforeElUpdated || (noop as any);
  const onElUpdated = options.onElUpdated || noop;
  const onBeforeNodeDiscarded = options.onBeforeNodeDiscarded || (noop as any);
  const onNodeDiscarded = options.onNodeDiscarded || noop;
  const onBeforeElChildrenUpdated = options.onBeforeElChildrenUpdated || (noop as any);
  const childrenOnly = options.childrenOnly === true;

  // Index every keyed node in the from-tree so we can match by key across positions.
  const fromNodesLookup: Record<string, any> = Object.create(null);
  const keyedRemovalList: string[] = [];

  function addKeyedRemoval(key: string): void {
    keyedRemovalList.push(key);
  }

  function walkDiscardedChildNodes(node: any, skipKeyedNodes: boolean): void {
    if (node.nodeType === ELEMENT_NODE) {
      let curChild = node.firstChild;
      while (curChild) {
        let key: string | undefined;
        if (skipKeyedNodes && (key = getNodeKey(curChild))) {
          addKeyedRemoval(key);
        } else {
          onNodeDiscarded(curChild);
          if (curChild.firstChild) walkDiscardedChildNodes(curChild, skipKeyedNodes);
        }
        curChild = curChild.nextSibling;
      }
    }
  }

  function removeNode(node: any, parentNode: any, skipKeyedNodes: boolean): void {
    if (onBeforeNodeDiscarded(node) === false) return;
    if (parentNode) parentNode.removeChild(node);
    onNodeDiscarded(node);
    walkDiscardedChildNodes(node, skipKeyedNodes);
  }

  function indexTree(node: any): void {
    if (node.nodeType === ELEMENT_NODE || node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      let curChild = node.firstChild;
      while (curChild) {
        const key = getNodeKey(curChild);
        if (key) fromNodesLookup[key] = curChild;
        indexTree(curChild);
        curChild = curChild.nextSibling;
      }
    }
  }
  indexTree(fromNode);

  function handleNodeAdded(el: any): void {
    onNodeAdded(el);
    let curChild = el.firstChild;
    while (curChild) {
      const nextSibling = curChild.nextSibling;
      const key = getNodeKey(curChild);
      if (key) {
        const unmatchedFromEl = fromNodesLookup[key];
        if (unmatchedFromEl && compareNodeNames(curChild, unmatchedFromEl)) {
          curChild.parentNode.replaceChild(unmatchedFromEl, curChild);
          morphEl(unmatchedFromEl, curChild, false);
        } else {
          handleNodeAdded(curChild);
        }
      } else {
        handleNodeAdded(curChild);
      }
      curChild = nextSibling;
    }
  }

  function morphChildren(fromEl: any, toEl: any): void {
    let curToNodeChild = toEl.firstChild;
    let curFromNodeChild = fromEl.firstChild;
    let curToNodeKey: string | undefined;
    let curFromNodeKey: string | undefined;
    let fromNextSibling: any;
    let toNextSibling: any;
    let matchingFromEl: any;

    outer: while (curToNodeChild) {
      toNextSibling = curToNodeChild.nextSibling;
      curToNodeKey = getNodeKey(curToNodeChild);

      while (curFromNodeChild) {
        fromNextSibling = curFromNodeChild.nextSibling;

        if (curToNodeChild.isSameNode && curToNodeChild.isSameNode(curFromNodeChild)) {
          curToNodeChild = toNextSibling;
          curFromNodeChild = fromNextSibling;
          continue outer;
        }

        curFromNodeKey = getNodeKey(curFromNodeChild);
        const curFromNodeType = curFromNodeChild.nodeType;

        let isCompatible: boolean | undefined;

        if (curFromNodeType === curToNodeChild.nodeType) {
          if (curFromNodeType === ELEMENT_NODE) {
            if (curToNodeKey) {
              if (curToNodeKey !== curFromNodeKey) {
                if ((matchingFromEl = fromNodesLookup[curToNodeKey])) {
                  if (fromNextSibling === matchingFromEl) {
                    isCompatible = false;
                  } else {
                    fromEl.insertBefore(matchingFromEl, curFromNodeChild);
                    if (curFromNodeKey) addKeyedRemoval(curFromNodeKey);
                    else removeNode(curFromNodeChild, fromEl, true);
                    curFromNodeChild = matchingFromEl;
                    curFromNodeKey = getNodeKey(curFromNodeChild);
                  }
                } else {
                  isCompatible = false;
                }
              }
            } else if (curFromNodeKey) {
              isCompatible = false;
            }

            isCompatible =
              isCompatible !== false && compareNodeNames(curFromNodeChild, curToNodeChild);
            if (isCompatible) morphEl(curFromNodeChild, curToNodeChild, false);
          } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
            isCompatible = true;
            if (curFromNodeChild.nodeValue !== curToNodeChild.nodeValue) {
              curFromNodeChild.nodeValue = curToNodeChild.nodeValue;
            }
          }
        }

        if (isCompatible) {
          curToNodeChild = toNextSibling;
          curFromNodeChild = fromNextSibling;
          continue outer;
        }

        if (curFromNodeKey) addKeyedRemoval(curFromNodeKey);
        else removeNode(curFromNodeChild, fromEl, true);
        curFromNodeChild = fromNextSibling;
      }

      if (
        curToNodeKey &&
        (matchingFromEl = fromNodesLookup[curToNodeKey]) &&
        compareNodeNames(matchingFromEl, curToNodeChild)
      ) {
        fromEl.appendChild(matchingFromEl);
        morphEl(matchingFromEl, curToNodeChild, false);
      } else {
        const onBeforeNodeAddedResult = onBeforeNodeAdded(curToNodeChild);
        if (onBeforeNodeAddedResult !== false) {
          if (onBeforeNodeAddedResult) curToNodeChild = onBeforeNodeAddedResult;
          fromEl.appendChild(curToNodeChild);
          handleNodeAdded(curToNodeChild);
        }
      }

      curToNodeChild = toNextSibling;
      curFromNodeChild = fromNextSibling;
    }

    // Remove any from-children left over after the to-children ran out.
    while (curFromNodeChild) {
      fromNextSibling = curFromNodeChild.nextSibling;
      if ((curFromNodeKey = getNodeKey(curFromNodeChild))) addKeyedRemoval(curFromNodeKey);
      else removeNode(curFromNodeChild, fromEl, true);
      curFromNodeChild = fromNextSibling;
    }

    const specialElHandler = specialElHandlers[fromEl.nodeName];
    if (specialElHandler) specialElHandler(fromEl, toEl);
  }

  function morphEl(fromEl: any, toEl: any, childrenOnlyEl: boolean): void {
    const toElKey = getNodeKey(toEl);
    if (toElKey) delete fromNodesLookup[toElKey];

    if (!childrenOnlyEl) {
      if (onBeforeElUpdated(fromEl, toEl) === false) return;
      morphAttrs(fromEl, toEl);
      onElUpdated(fromEl);
      if (onBeforeElChildrenUpdated(fromEl, toEl) === false) return;
    }

    if (fromEl.nodeName !== 'TEXTAREA') {
      morphChildren(fromEl, toEl);
    } else {
      specialElHandlers.TEXTAREA!(fromEl, toEl);
    }
  }

  let morphedNode: any = fromNode;
  const morphedNodeType = (morphedNode as any).nodeType;
  const toNodeType = (toNode as any).nodeType;

  if (!childrenOnly) {
    if (morphedNodeType === ELEMENT_NODE) {
      if (toNodeType === ELEMENT_NODE) {
        if (!compareNodeNames(fromNode, toNode)) {
          onNodeDiscarded(fromNode);
          morphedNode = moveChildren(
            fromNode,
            createElementNS((toNode as any).nodeName, (toNode as any).namespaceURI),
          );
        }
      } else {
        morphedNode = toNode;
      }
    } else if (morphedNodeType === TEXT_NODE || morphedNodeType === COMMENT_NODE) {
      if (toNodeType === morphedNodeType) {
        if (morphedNode.nodeValue !== (toNode as any).nodeValue) {
          morphedNode.nodeValue = (toNode as any).nodeValue;
        }
        return morphedNode;
      }
      morphedNode = toNode;
    }
  }

  if (morphedNode === toNode) {
    onNodeDiscarded(fromNode);
  } else {
    if ((toNode as any).isSameNode && (toNode as any).isSameNode(morphedNode)) return morphedNode;

    morphEl(morphedNode, toNode, childrenOnly);

    for (let i = 0, len = keyedRemovalList.length; i < len; i++) {
      const elToRemove = fromNodesLookup[keyedRemovalList[i]!];
      if (elToRemove) removeNode(elToRemove, elToRemove.parentNode, false);
    }
  }

  if (morphedNode !== fromNode && (fromNode as any).parentNode) {
    (fromNode as any).parentNode.replaceChild(morphedNode, fromNode);
  }
  return morphedNode;
}

let morphParseTemplate: HTMLTemplateElement | null = null;

/**
 * Morph an HTML string into a live element in place. The string's first element node is
 * used as the target tree (its tag should match `liveEl`). Returns the morphed element.
 */
export function morphElement(liveEl: Element, html: string, options: MorphOptions = {}): Node {
  if (!morphParseTemplate) morphParseTemplate = document.createElement('template');
  morphParseTemplate.innerHTML = html;
  const toNode = morphParseTemplate.content.firstElementChild;
  if (!toNode) return liveEl;
  return morphdom(liveEl, toNode, options);
}

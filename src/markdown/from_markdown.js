import markdownit from "markdown-it"
import {BlockQuote, OrderedList, BulletList, ListItem,
        HorizontalRule, Paragraph, Heading, CodeBlock, Image, HardBreak,
        EmMark, StrongMark, LinkMark, CodeMark, Mark} from "../model"
import {defineSource} from "../format"
import {AssertionError} from "../util/error"

// :: (Schema, string) → Node
// Parse a string as [CommonMark](http://commonmark.org/) markup, and
// create a ProseMirror document corresponding to its meaning. Note
// that, by default, some CommonMark features, namely inline HTML and
// tight lists, are not supported.
export function fromMarkdown(schema, text) {
  let tokens = markdownit("commonmark").parse(text, {})
  let state = new MarkdownParseState(schema, tokens), doc
  state.parseTokens(tokens)
  do { doc = state.closeNode() } while (state.stack.length)
  return doc
}

// ;; #kind=interface #path=MarkdownParseSpec
// Schema-specific parsing logic can be defined by adding a
// `parseMarkdown` property to the prototype of your node or mark
// types, preferably using the type's [`register`](#SchemaItem.register)
// method, that contains an array of objects following this parsing
// specification interface.

// :: string #path=MarkdownParseSpec.token
// Used to specify the
// [markdown-it](https://github.com/markdown-it/markdown-it) token
// type that should trigger this specification.

// :: union<string, (state: MarkdownParseState, token: MarkdownToken) → Node> #path=MarkdownParseSpec.parse
// The parsing function for this token. It is, when a matching token
// is encountered, passed the parsing state and the token, and must
// return a `Node` if the parsing spec was for a node type, and a
// `Mark` if it was for a mark type.
//
// The function will be called so that `this` is bound to the node or
// mark type instance that the spec was associated with.
//
// As a shorthand, `parse` can be set to a string. You can use
// `"block"` to create a node of the type that this spec was
// associated with, and wrap the content between the open and close
// tokens in this node.
//
// Alternatively, it can be set to `"mark"`, if the spec is associated
// with a [mark type](#MarkType), which will cause the content between
// the opening and closing token to be marked with an instance of that
// mark type.

// :: ?union<Object, (MarkdownParseState, MarkdownToken) → Object> #path=MarkdownParseSpec.attrs
// When `parse` is set to a string, this property can be used to
// specify attributes for the node or mark. It may hold an object or a
// function that, when called with the [parser
// state](#MarkdownParseState) and the token object, returns an
// attribute object.

defineSource("markdown", fromMarkdown)

const noMarks = []

function maybeMerge(a, b) {
  if (a.isText && b.isText && Mark.sameSet(a.marks, b.marks))
    return a.copy(a.text + b.text)
}

// ;; Object used to track the context of a running parse,
// and to expose parsing-related methods to node-specific parsing
// functions.
class MarkdownParseState {
  constructor(schema, tokens) {
    // :: Schema
    // The schema into which we are parsing.
    this.schema = schema
    this.stack = [{type: schema.nodes.doc, content: []}]
    this.tokens = tokens
    this.marks = noMarks
    this.tokenTypes = tokenTypeInfo(schema)
  }

  top() {
    return this.stack[this.stack.length - 1]
  }

  push(elt) {
    if (this.stack.length)
      this.top().content.push(elt)
  }

  // :: (string)
  // Adds the given text to the current position in the document,
  // using the current marks as styling.
  addText(text) {
    let nodes = this.top().content, last = nodes[nodes.length - 1]
    let node = this.schema.text(text, this.marks), merged
    if (last && (merged = maybeMerge(last, node))) nodes[nodes.length - 1] = merged
    else nodes.push(node)
  }

  // :: (Mark)
  // Adds the given mark to the set of active marks.
  openMark(mark) {
    this.marks = mark.addToSet(this.marks)
  }

  // :: (Mark)
  // Removes the given mark from the set of active marks.
  closeMark(mark) {
    this.marks = mark.removeFromSet(this.marks)
  }

  parseTokens(toks) {
    for (let i = 0; i < toks.length; i++) {
      let tok = toks[i]
      let tokenType = this.tokenTypes[tok.type]
      if (!tokenType)
        throw new Error("Token type `" + tok.type + "` not supported by Markdown parser")

      tokenType(this, tok)
    }
  }

  // :: (NodeType, ?Object, ?[Node]) → Node
  // Add a node at the current position.
  addNode(type, attrs, content) {
    let node = type.createAutoFill(attrs, content, this.marks)
    this.push(node)
    return node
  }

  // :: (NodeType, ?Object)
  // Wrap subsequent content in a node of the given type.
  openNode(type, attrs) {
    this.stack.push({type: type, attrs: attrs, content: []})
  }

  // :: () → Node
  // Close and return the node that is currently on top of the stack.
  closeNode() {
    if (this.marks.length) this.marks = noMarks
    let info = this.stack.pop()
    return this.addNode(info.type, info.attrs, info.content)
  }

  // :: (MarkdownToken, string) → any
  // Retrieve the named attribute from the given token.
  getAttr(tok, name) {
    if (tok.attrs) for (let i = 0; i < tok.attrs.length; i++)
      if (tok.attrs[i][0] == name) return tok.attrs[i][1]
  }
}

function tokenTypeInfo(schema) {
  return schema.cached.markdownTokens ||
    (schema.cached.markdownTokens = summarizeTokens(schema))
}

function registerTokens(tokens, type, info) {
  if (info.parse == "block") {
    tokens[info.token + "_open"] = (state, tok) => {
      let attrs = typeof info.attrs == "function" ? info.attrs(state, tok) : info.attrs
      state.openNode(type, attrs)
    }
    tokens[info.token + "_close"] = state => state.closeNode()
  } else if (info.parse == "mark") {
    tokens[info.token + "_open"] = (state, tok) => {
      let attrs = info.attrs instanceof Function ? info.attrs(state, tok) : info.attrs
      state.openMark(type.create(attrs))
    }
    tokens[info.token + "_close"] = state => state.closeMark(type)
  } else if (info.parse) {
    tokens[info.token] = info.parse.bind(type)
  } else {
    AssertionError.raise("Unrecognized markdown parsing spec: " + info)
  }
}

function summarizeTokens(schema) {
  let tokens = Object.create(null)
  tokens.text = (state, tok) => state.addText(tok.content)
  tokens.inline = (state, tok) => state.parseTokens(tok.children)
  tokens.softbreak = state => state.addText("\n")

  schema.registry("parseMarkdown", (info, type) => {
    registerTokens(tokens, type, info)
  })
  return tokens
}

BlockQuote.register("parseMarkdown", {parse: "block", token: "blockquote"})

Paragraph.register("parseMarkdown", {parse: "block", token: "paragraph"})

ListItem.register("parseMarkdown", {parse: "block", token: "list_item"})

BulletList.register("parseMarkdown", {parse: "block", token: "bullet_list"})

OrderedList.register("parseMarkdown", {parse: "block", token: "ordered_list", attrs: (state, tok) => ({
  order: Number(state.getAttr(tok, "order") || 1)
})})

Heading.register("parseMarkdown", {parse: "block", token: "heading", attrs: (_, tok) => ({
  level: tok.tag.slice(1)
})})

function trimTrailingNewline(str) {
  if (str.charAt(str.length - 1) == "\n")
    return str.slice(0, str.length - 1)
  return str
}

function parseCodeBlock(state, tok) {
  state.openNode(this)
  state.addText(trimTrailingNewline(tok.content))
  state.closeNode()
}

CodeBlock.register("parseMarkdown", {token: "code_block", parse: parseCodeBlock})
CodeBlock.register("parseMarkdown", {token: "fence", parse: parseCodeBlock})

HorizontalRule.register("parseMarkdown", {token: "hr", parse: function(state, tok) {
  state.addNode(this, {markup: tok.markup})
}})

Image.register("parseMarkdown", {token: "image", parse: function(state, tok) {
  state.addNode(this, {src: state.getAttr(tok, "src"),
                       title: state.getAttr(tok, "title") || null,
                       alt: tok.children[0] && tok.children[0].content || null})
}})

HardBreak.register("parseMarkdown", {token: "hardbreak", parse: function(state) {
  state.addNode(this)
}})

// Inline marks

EmMark.register("parseMarkdown", {parse: "mark", token: "em"})

StrongMark.register("parseMarkdown", {parse: "mark", token: "strong"})

LinkMark.register("parseMarkdown", {
  parse: "mark",
  token: "link",
  attrs: (state, tok) => ({
    href: state.getAttr(tok, "href"),
    title: state.getAttr(tok, "title") || null
  })
})

CodeMark.register("parseMarkdown", {token: "code_inline", parse: function(state, tok) {
  state.openMark(this.create())
  state.addText(tok.content)
  state.closeMark(this)
}})

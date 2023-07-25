export default {
  name: "artist",
  type: "document",
  title: "Artist",
  fields: [
    {
      name: "discogs_id",
      type: "string",
      title: "Discogs ID",
      readOnly: true,
    },
    {
      name: "name",
      type: "string",
      title: "Name",
    },
  ],
};
